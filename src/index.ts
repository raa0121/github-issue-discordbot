import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  TextStyleTypes,
} from 'discord-interactions';
import { editOriginalResponse, jsonResponse, verifyDiscordRequest } from './discord.js';
import type { Env } from './env.js';
import {
  GITHUB_APP_INSTALL_URL,
  createIssue,
  describeTemplate,
  listIssueTemplates,
  listUserInstallations,
  listUserRepositories,
} from './github.js';
import { buildIssueBody } from './issue-body.js';
import {
  CALLBACK_PATH,
  CONFIRM_PATH,
  DiscordUser,
  authorizeUrl,
  createOAuthState,
  deleteLink,
  getLink,
  getUserToken,
  revokeToken,
} from './oauth.js';
import { summarize } from './summarize.js';
import { deleteSession, getSession, setSession, MessageEntry, SessionOf } from './session.js';
import { errorPage, handleOAuthCallback, handleOAuthConfirm, landingPage } from './web.js';

const PAGE_SIZE = 25;
const DEFAULT_COUNT = 20;
const MAX_COUNT = 25;

type MessageBody = { content: string; components: object[]; embeds?: object[] };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return landingPage(env);
    if (request.method === 'GET' && url.pathname === CALLBACK_PATH) {
      return handleOAuthCallback(request, env).catch(errorPage);
    }
    if (request.method === 'POST' && url.pathname === CONFIRM_PATH) {
      return handleOAuthConfirm(request, env).catch(errorPage);
    }
    if (request.method !== 'POST') return jsonResponse({ error: 'Method Not Allowed' }, 405);

    const interaction = await verifyDiscordRequest(request, env);
    if (!interaction) return jsonResponse({ error: 'Bad request signature' }, 401);

    switch (interaction.type) {
      case InteractionType.PING:
        return jsonResponse({ type: InteractionResponseType.PONG });
      case InteractionType.APPLICATION_COMMAND:
        return handleCommand(interaction, env, ctx, url.origin);
      case InteractionType.MESSAGE_COMPONENT:
        return handleComponent(interaction, env, ctx);
      case InteractionType.MODAL_SUBMIT:
        return handleModalSubmit(interaction, env);
      default:
        return jsonResponse({ error: 'Not handled' }, 400);
    }
  },
};

// ---------- インタラクション処理 ----------

function handleCommand(interaction: any, env: Env, ctx: ExecutionContext, origin: string): Response {
  const deferred = jsonResponse({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });
  const user = discordUser(interaction);

  switch (interaction.data.name) {
    case 'issue': {
      const countOption = interaction.data.options?.find((o: { name: string }) => o.name === 'count')?.value;
      const count = Math.min(MAX_COUNT, Math.max(1, Number(countOption ?? DEFAULT_COUNT)));
      const sessionId = crypto.randomUUID();

      return respondThenEdit(deferred, ctx, env, interaction.token, async () => {
        const token = await getUserToken(env, user.id);
        if (!token) return linkPrompt(env, origin, user);

        const installs = await listUserInstallations(token);
        if (installs.length === 0) {
          return withInstallLink(
            '⚠️ あんたが権限を持つリポジトリに、この GitHub App がインストールされていないよ。\n' +
              '下のボタンから App をインストールして（リポジトリのオーナーだけができるよ）、もう一度 `/issue` を実行してね。\n' +
              '別の GitHub アカウントを使いたいなら、`/issue-unlink` で連携を解除してから連携し直してね。',
          );
        }
        if (installs.length === 1) {
          return startRepoStep(env, token, sessionId, installs[0].id, count);
        }

        const session: SessionOf<'install'> = { step: 'install', installs, count };
        await setSession(env.KV, sessionId, session);
        return installMessage(session, sessionId);
      });
    }

    case 'issue-unlink':
      return respondThenEdit(deferred, ctx, env, interaction.token, async () => {
        const link = await getLink(env.KV, user.id);
        if (!link) return message('GitHub アカウントはまだ連携されていないよ。');
        await revokeToken(env, link.accessToken).catch((err) => console.error(err));
        await deleteLink(env.KV, user.id);
        return message(`GitHub アカウント **${link.githubLogin}** との連携を解除したよ。`);
      });

    default:
      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '未対応のコマンドだよ…', flags: InteractionResponseFlags.EPHEMERAL },
      });
  }
}

async function handleComponent(interaction: any, env: Env, ctx: ExecutionContext): Promise<Response> {
  const [kind, sessionId, arg] = (interaction.data.custom_id as string).split(':');
  const session = await getSession(env.KV, sessionId);
  const expired = updateMessage(message('セッションが期限切れだよ…もう一度 `/issue` してね。'));
  const userId = discordUser(interaction).id;

  switch (kind) {
    case 'install_select': {
      if (session?.step !== 'install') return expired;
      const installationId = Number(interaction.data.values[0]);
      return respondThenEdit(updateMessage(message('📚 リポジトリを読み込み中だよ…')), ctx, env, interaction.token, () =>
        withUserToken(env, userId, (token) => startRepoStep(env, token, sessionId, installationId, session.count)),
      );
    }

    case 'repo_page': {
      if (session?.step !== 'repo') return expired;
      const delta = arg === 'next' ? 1 : -1;
      session.page = Math.max(0, Math.min(session.page + delta, totalPages(session) - 1));
      await setSession(env.KV, sessionId, session);
      return updateMessage(repoMessage(session, sessionId));
    }

    case 'repo_select': {
      if (session?.step !== 'repo') return expired;
      const [owner, name] = (interaction.data.values[0] as string).split('/');
      const repo = { owner, name, fullName: `${owner}/${name}`, installationId: session.installationId };
      const loading = updateMessage(message('💬 メッセージとテンプレートを読み込み中だよ…'));
      return respondThenEdit(loading, ctx, env, interaction.token, () =>
        withUserToken(env, userId, async (token) => {
          const [messages, { source, templates }] = await Promise.all([
            fetchRecentMessages(env, interaction.channel_id, interaction.guild_id, session.count),
            // テンプレートは要約の質を上げるための補助なので、読めなくても issue 作成は止めない
            listIssueTemplates(token, owner, name).catch((err) => {
              console.error(err);
              return { source: null, templates: [] };
            }),
          ]);
          if (messages.length === 0) return message('メッセージが見つからなかったよ…');

          if (templates.length >= 2) {
            const next: SessionOf<'template'> = { step: 'template', repo, messages, templates, templateSource: source };
            await setSession(env.KV, sessionId, next);
            return templateSelectMessage(next, sessionId);
          }
          const next: SessionOf<'messages'> = { step: 'messages', repo, messages, templates, templateSource: source };
          await setSession(env.KV, sessionId, next);
          return messageSelectMessage(next, sessionId);
        }),
      );
    }

    case 'template_select': {
      if (session?.step !== 'template') return expired;
      const choice = interaction.data.values[0] as string;
      const templates =
        choice === TEMPLATE_AUTO
          ? session.templates
          : choice === TEMPLATE_NONE
            ? []
            : session.templates.filter((_, i) => String(i) === choice);
      const next: SessionOf<'messages'> = {
        step: 'messages',
        repo: session.repo,
        messages: session.messages,
        templates,
        templateSource: templates.length > 0 ? session.templateSource : null,
      };
      await setSession(env.KV, sessionId, next);
      return updateMessage(messageSelectMessage(next, sessionId));
    }

    case 'msg_select': {
      if (session?.step !== 'messages') return expired;
      const selectedIds = new Set<string>(interaction.data.values);
      const selected = session.messages
        .filter((m) => selectedIds.has(m.id))
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      return respondThenEdit(updateMessage(message('🧠 要約中だよ…')), ctx, env, interaction.token, () =>
        summarizeToPreview(env, sessionId, { ...session, messages: selected }),
      );
    }

    case 'issue_regen': {
      if (session?.step !== 'preview') return expired;
      return respondThenEdit(updateMessage(message('🔄 要約し直してるよ…')), ctx, env, interaction.token, () =>
        summarizeToPreview(env, sessionId, session),
      );
    }

    case 'issue_create': {
      if (session?.step !== 'preview') return expired;
      return respondThenEdit(updateMessage(message('📝 issue を作成中だよ…')), ctx, env, interaction.token, () =>
        withUserToken(env, userId, (token) => createIssueFromPreview(env, token, sessionId, session)),
      );
    }

    case 'issue_edit': {
      if (session?.step !== 'preview') return expired;
      return jsonResponse({ type: InteractionResponseType.MODAL, data: editModal(session, sessionId) });
    }

    case 'issue_cancel': {
      if (session?.step !== 'preview') return expired;
      await deleteSession(env.KV, sessionId);
      return updateMessage(message('issue の作成をキャンセルしたよ。'));
    }

    default:
      return jsonResponse({ error: 'Not handled' }, 400);
  }
}

async function handleModalSubmit(interaction: any, env: Env): Promise<Response> {
  const [kind, sessionId] = (interaction.data.custom_id as string).split(':');
  if (kind !== 'issue_edit_submit') return jsonResponse({ error: 'Not handled' }, 400);

  const session = await getSession(env.KV, sessionId);
  if (session?.step !== 'preview') {
    return updateMessage(message('セッションが期限切れだよ…もう一度 `/issue` してね。'));
  }

  const values = modalValues(interaction.data.components);
  const next: SessionOf<'preview'> = {
    ...session,
    title: values.get('title')?.trim() || session.title,
    body: values.get('body')?.trim() || session.body,
  };
  await setSession(env.KV, sessionId, next);
  return updateMessage(previewMessage(next, sessionId));
}

// 送信内容は action row に包まれた旧形式と label に包まれた新形式があるので、入れ子を辿って拾う
function modalValues(components: any[] = []): Map<string, string> {
  const values = new Map<string, string>();
  const walk = (c: any) => {
    if (typeof c?.custom_id === 'string' && typeof c.value === 'string') values.set(c.custom_id, c.value);
    c?.components?.forEach(walk);
    if (c?.component) walk(c.component);
  };
  components.forEach(walk);
  return values;
}

// Discord は 3 秒以内に応答しないとインタラクション失敗扱いにする。GitHub / Workers AI を呼ぶ処理は
// 先に応答を返し、結果は waitUntil の中で元メッセージを編集して届ける。
function respondThenEdit(
  initial: Response,
  ctx: ExecutionContext,
  env: Env,
  token: string,
  work: () => Promise<MessageBody>,
): Response {
  ctx.waitUntil(
    work()
      .catch((err): MessageBody => {
        console.error(err);
        return message(`💥 エラー: ${err instanceof Error ? err.message : '不明なエラー'}`);
      })
      .then((body) => editOriginalResponse(env, token, body))
      .catch((err) => console.error(err)),
  );
  return initial;
}

function discordUser(interaction: any): DiscordUser {
  // サーバー内では member.user、DM では user に入っている
  const user = interaction.member?.user ?? interaction.user;
  return { id: user.id, name: user.global_name ? `${user.global_name} (@${user.username})` : `@${user.username}` };
}

async function withUserToken(
  env: Env,
  discordUserId: string,
  fn: (token: string) => Promise<MessageBody>,
): Promise<MessageBody> {
  const token = await getUserToken(env, discordUserId);
  if (!token) return message('GitHub との連携が切れたよ…もう一度 `/issue` からやり直してね。');
  return fn(token);
}

async function linkPrompt(env: Env, origin: string, user: DiscordUser): Promise<MessageBody> {
  const state = await createOAuthState(env.KV, user);
  return {
    content:
      'issue を作るには、まず GitHub アカウントとの連携が必要だよ。\n' +
      '下のボタンから GitHub で認可して、連携できたらもう一度 `/issue` を実行してね。（リンクは 10 分間有効だよ）',
    components: [
      {
        type: MessageComponentTypes.ACTION_ROW,
        components: [
          {
            type: MessageComponentTypes.BUTTON,
            style: ButtonStyleTypes.LINK,
            label: 'GitHub と連携する',
            url: authorizeUrl(env, state, origin + CALLBACK_PATH),
          },
        ],
      },
    ],
    embeds: [],
  };
}

async function startRepoStep(
  env: Env,
  token: string,
  sessionId: string,
  installationId: number,
  count: number,
): Promise<MessageBody> {
  const repos = await listUserRepositories(token, installationId);
  if (repos.length === 0) {
    return withInstallLink(
      '⚠️ このインストール先には、あんたが issue を作れるリポジトリがないよ…\n' +
        '使いたいリポジトリが App の対象に入っていないなら、下のボタンから追加して、もう一度 `/issue` を実行してね。',
    );
  }

  const session: SessionOf<'repo'> = { step: 'repo', installationId, repos, page: 0, count };
  await setSession(env.KV, sessionId, session);
  return repoMessage(session, sessionId);
}

async function summarizeToPreview(
  env: Env,
  sessionId: string,
  { repo, messages, templates, templateSource }: Omit<SessionOf<'messages'>, 'step'>,
): Promise<MessageBody> {
  const transcript = messages
    .map((m, i) => `[${i + 1}] ${m.author} (${m.createdAt})\n${m.content}\n🔗 ${m.url}`)
    .join('\n\n');

  const { title, body } = await summarize(env.AI, transcript, templates);
  const session: SessionOf<'preview'> = { step: 'preview', repo, messages, title, body, templates, templateSource };
  await setSession(env.KV, sessionId, session);
  return previewMessage(session, sessionId);
}

async function createIssueFromPreview(
  env: Env,
  token: string,
  sessionId: string,
  session: SessionOf<'preview'>,
): Promise<MessageBody> {
  const { repo } = session;
  const issueBody = buildIssueBody(session.body, session.messages);
  const url = await createIssue(token, repo.owner, repo.name, session.title, issueBody);
  await deleteSession(env.KV, sessionId);
  return message(`🎉 **${repo.fullName}** に issue を作成したよ！\n${url}`);
}

// ---------- UI ビルダー ----------

// embeds を明示的に空にしないと、プレビューの Embed が後続の編集後も残る
function message(content: string): MessageBody {
  return { content, components: [], embeds: [] };
}

function withInstallLink(content: string): MessageBody {
  return {
    content,
    components: [
      {
        type: MessageComponentTypes.ACTION_ROW,
        components: [
          {
            type: MessageComponentTypes.BUTTON,
            style: ButtonStyleTypes.LINK,
            label: 'GitHub App をインストールする',
            url: GITHUB_APP_INSTALL_URL,
          },
        ],
      },
    ],
    embeds: [],
  };
}

function updateMessage(body: MessageBody): Response {
  return jsonResponse({ type: InteractionResponseType.UPDATE_MESSAGE, data: body });
}

function selectRow(select: object) {
  return { type: MessageComponentTypes.ACTION_ROW, components: [{ type: MessageComponentTypes.STRING_SELECT, ...select }] };
}

function installMessage(session: SessionOf<'install'>, sessionId: string): MessageBody {
  return {
    content: 'GitHub App がインストールされているアカウントを選んでね！',
    components: [
      selectRow({
        custom_id: `install_select:${sessionId}`,
        placeholder: 'アカウントを選んでね',
        options: session.installs.slice(0, 25).map((i) => ({
          label: truncate(i.account, 100),
          value: String(i.id),
          description: `Installation ID: ${i.id}`,
        })),
      }),
    ],
  };
}

function totalPages(session: SessionOf<'repo'>) {
  return Math.ceil(session.repos.length / PAGE_SIZE);
}

function repoMessage(session: SessionOf<'repo'>, sessionId: string): MessageBody {
  const pages = totalPages(session);
  const pageRepos = session.repos.slice(session.page * PAGE_SIZE, (session.page + 1) * PAGE_SIZE);

  const components: object[] = [
    selectRow({
      custom_id: `repo_select:${sessionId}`,
      placeholder: 'issue を立てるリポジトリを選んでね',
      options: pageRepos.map((r) => ({ label: truncate(r.fullName, 100), value: `${r.owner}/${r.name}` })),
    }),
  ];

  if (pages > 1) {
    const button = (direction: 'prev' | 'next', label: string, disabled: boolean) => ({
      type: MessageComponentTypes.BUTTON,
      custom_id: `repo_page:${sessionId}:${direction}`,
      label,
      style: ButtonStyleTypes.SECONDARY,
      disabled,
    });
    components.push({
      type: MessageComponentTypes.ACTION_ROW,
      components: [button('prev', '◀ 前へ', session.page === 0), button('next', '次へ ▶', session.page === pages - 1)],
    });
  }

  return { content: `リポジトリを選んでね（${session.page + 1} / ${pages} ページ）`, components };
}

const TEMPLATE_AUTO = 'auto';
const TEMPLATE_NONE = 'none';

function templateSelectMessage(session: SessionOf<'template'>, sessionId: string): MessageBody {
  const sourceNote = session.templateSource && session.templateSource !== 'repo' ? `（${session.templateSource} の既定）` : '';
  return {
    content: `**${session.repo.fullName}** の issue テンプレート${sourceNote}を選んでね！`,
    components: [
      selectRow({
        custom_id: `template_select:${sessionId}`,
        placeholder: 'テンプレートを選んでね',
        options: [
          { label: '🤖 AI に任せる', value: TEMPLATE_AUTO, description: '会話の内容に一番合うテンプレートを AI が選ぶよ' },
          ...session.templates.map((t, i) => {
            const { name, description } = describeTemplate(t);
            return {
              label: truncate(name, 100),
              value: String(i),
              ...(description ? { description: truncate(description, 100) } : {}),
            };
          }),
          { label: 'テンプレートを使わない', value: TEMPLATE_NONE, description: '議題・決定事項・次のアクションの形で要約するよ' },
        ],
      }),
    ],
  };
}

function templateNote(session: SessionOf<'preview'>): string {
  const { templates, templateSource } = session;
  if (templates.length === 0) return '';
  const where = templateSource && templateSource !== 'repo' ? `（${templateSource}）` : '';
  return templates.length === 1
    ? `テンプレート「${describeTemplate(templates[0]).name}」${where}に沿って書いたよ`
    : `テンプレート ${templates.length} 件${where}から AI が選んだよ`;
}

function messageSelectMessage(session: SessionOf<'messages'>, sessionId: string): MessageBody {
  return {
    content: `**${session.repo.fullName}** に issue を立てるよ！\n直近 **${session.messages.length}件** から要約したいメッセージを選んでね。`,
    components: [
      selectRow({
        custom_id: `msg_select:${sessionId}`,
        placeholder: '要約したいメッセージを選んでね（複数選択可）',
        min_values: 1,
        max_values: session.messages.length,
        options: session.messages.map((m, i) => ({
          label: truncate(`${i + 1}. ${m.author}: ${m.content.replace(/\n/g, ' ')}`, 100),
          value: m.id,
          description: truncate(m.createdAt, 100),
        })),
      }),
    ],
  };
}

function previewMessage(session: SessionOf<'preview'>, sessionId: string): MessageBody {
  const button = (action: 'create' | 'edit' | 'regen' | 'cancel', label: string, style: ButtonStyleTypes) => ({
    type: MessageComponentTypes.BUTTON,
    custom_id: `issue_${action}:${sessionId}`,
    label,
    style,
  });
  return {
    content: `**${session.repo.fullName}** にこの内容で issue を立てるよ。よければ「作成する」を押してね！`,
    // Discord の Embed は title 256 文字、description 4096 文字まで
    embeds: [
      {
        title: truncate(session.title, 256),
        description: truncate(session.body, 4096),
        footer: {
          text: [`元チャット ${session.messages.length} 件は issue 本文に折りたたんで添付するよ`, templateNote(session)]
            .filter(Boolean)
            .join(' / '),
        },
      },
    ],
    components: [
      {
        type: MessageComponentTypes.ACTION_ROW,
        components: [
          button('create', '✅ 作成する', ButtonStyleTypes.SUCCESS),
          button('edit', '✏️ 編集', ButtonStyleTypes.PRIMARY),
          button('regen', '🔄 再生成', ButtonStyleTypes.SECONDARY),
          button('cancel', 'キャンセル', ButtonStyleTypes.DANGER),
        ],
      },
    ],
  };
}

// テキスト入力の value は 4000 文字まで。超える本文を切って入れると送信時に後半が消えるため、その場合は本文欄を出さない
const TEXT_INPUT_MAX = 4000;
const GITHUB_TITLE_MAX = 256;

function editModal(session: SessionOf<'preview'>, sessionId: string) {
  const input = (custom_id: string, label: string, style: TextStyleTypes, value: string, max_length: number) => ({
    type: MessageComponentTypes.ACTION_ROW,
    components: [
      { type: MessageComponentTypes.INPUT_TEXT, custom_id, label, style, value, max_length, min_length: 1, required: true },
    ],
  });
  const bodyEditable = session.body.length <= TEXT_INPUT_MAX;

  return {
    custom_id: `issue_edit_submit:${sessionId}`,
    title: bodyEditable ? 'issue を編集' : 'タイトルを編集（本文は 4000 文字超のため不可）',
    components: [
      input('title', 'タイトル', TextStyleTypes.SHORT, session.title.slice(0, GITHUB_TITLE_MAX), GITHUB_TITLE_MAX),
      ...(bodyEditable ? [input('body', '本文（Markdown）', TextStyleTypes.PARAGRAPH, session.body, TEXT_INPUT_MAX)] : []),
    ],
  };
}

// ---------- Discord API ----------

async function fetchRecentMessages(
  env: Env,
  channelId: string,
  guildId: string | undefined,
  limit: number,
): Promise<MessageEntry[]> {
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`, {
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` },
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
    // 50001: Missing Access（チャンネルが見えない）、50013: Missing Permissions（履歴を読めない）
    if (error.code === 50001 || error.code === 50013) {
      throw new Error(
        'Bot がこのチャンネルのメッセージを読めないよ。\n' +
          'チャンネルの設定 →「権限」で、Bot に「チャンネルを見る」と「メッセージ履歴を読む」を許可してね。' +
          '非公開スレッドの場合は、スレッドに Bot を追加してね。',
      );
    }
    throw new Error(`Discord API エラー: ${res.status} ${error.message ?? ''}`.trim());
  }
  const data: any[] = await res.json();
  return data
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .map((m) => ({
      id: m.id,
      author: m.author.global_name || m.author.username,
      content: m.content || (m.attachments?.length ? '[添付ファイル]' : '(空)'),
      url: `https://discord.com/channels/${guildId ?? '@me'}/${channelId}/${m.id}`,
      createdAt: m.timestamp,
    }));
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}
