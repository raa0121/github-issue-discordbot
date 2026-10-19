import type { Env } from './env.js';
import { GITHUB_APP_INSTALL_URL, getAuthenticatedUser } from './github.js';
import {
  CALLBACK_PATH,
  CONFIRM_PATH,
  consumeOAuthState,
  consumePendingLink,
  createPendingLink,
  exchangeCode,
  revokeToken,
  saveLink,
} from './oauth.js';

// 他人に送りつけた認可リンクを踏ませると、踏んだ人の GitHub が送り主の Discord に紐づいてしまう。
// それを防ぐため、どの Discord アカウントと連携するかを表示して本人に確定させる
export async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get('error')) {
    return page('連携をキャンセルしたよ', '<p>GitHub での認可がキャンセルされたよ。</p>');
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthState = code && state ? await consumeOAuthState(env.KV, state) : null;
  if (!code || !oauthState) {
    return page('リンクの期限が切れたよ', '<p>Discord に戻って、もう一度 <code>/issue</code> を実行してね。</p>', 400);
  }

  const tokens = await exchangeCode(env, code, url.origin + CALLBACK_PATH);
  const user = await getAuthenticatedUser(tokens.accessToken);
  const nonce = await createPendingLink(env.KV, {
    discordUser: oauthState.discordUser,
    link: { ...tokens, githubId: user.id, githubLogin: user.login },
  });

  return page(
    'アカウントを連携する',
    `<p>Discord の <strong>${escapeHtml(oauthState.discordUser.name)}</strong> と、GitHub の <strong>${escapeHtml(user.login)}</strong> を連携するよ。</p>
<p>連携すると、この Discord アカウントから <strong>${escapeHtml(user.login)}</strong> として issue を作成できるようになるよ。自分の Discord アカウントでなければ「連携しない」を押してね。</p>
<form method="post" action="${CONFIRM_PATH}">
  <input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
  <button type="submit" name="action" value="link">連携する</button>
  <button type="submit" name="action" value="cancel">連携しない</button>
</form>`,
  );
}

export async function handleOAuthConfirm(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const nonce = form.get('nonce');
  const pending = typeof nonce === 'string' ? await consumePendingLink(env.KV, nonce) : null;
  if (!pending) {
    return page('リンクの期限が切れたよ', '<p>Discord に戻って、もう一度 <code>/issue</code> を実行してね。</p>', 400);
  }

  if (form.get('action') !== 'link') {
    await revokeToken(env, pending.link.accessToken).catch((err) => console.error(err));
    return page('連携しなかったよ', '<p>アカウントは連携していないよ。このページは閉じて大丈夫。</p>');
  }

  await saveLink(env.KV, pending.discordUser.id, pending.link);
  return page(
    '連携できたよ！',
    `<p>GitHub の <strong>${escapeHtml(pending.link.githubLogin)}</strong> と連携したよ。Discord に戻って、もう一度 <code>/issue</code> を実行してね。</p>
<h2>使いたいリポジトリが一覧に出ないときは</h2>
<p>issue を作りたいリポジトリに、この GitHub App がインストールされている必要があるよ。まだなら、リポジトリのオーナー（組織ならオーナー）が下のページからインストールしてね。インストール済みでも、使えるリポジトリを絞っている場合はここから追加できるよ。</p>
<p><a href="${GITHUB_APP_INSTALL_URL}">GitHub App をインストールする</a></p>`,
  );
}

// Bot はチャンネルの直近メッセージを読むので、閲覧とメッセージ履歴の権限が要る
const DISCORD_BOT_PERMISSIONS = 1024 /* VIEW_CHANNEL */ + 65536; /* READ_MESSAGE_HISTORY */

export function landingPage(env: Env): Response {
  const inviteUrl = `https://discord.com/oauth2/authorize?${new URLSearchParams({
    client_id: env.DISCORD_APPLICATION_ID,
    scope: 'bot applications.commands',
    permissions: String(DISCORD_BOT_PERMISSIONS),
  })}`;

  return page(
    'issue-discordbot',
    `<p class="lead">Discord の会話を AI で要約して、GitHub の issue を作れる Bot です。</p>
<div class="actions">
  <a class="button" href="${escapeHtml(inviteUrl)}">Discord サーバーに追加する</a>
  <a class="button secondary" href="${GITHUB_APP_INSTALL_URL}">GitHub リポジトリにインストールする</a>
</div>

<h2>導入</h2>
<ol>
  <li><strong>Discord サーバーの管理者</strong>：「Discord サーバーに追加する」から Bot をサーバーに追加します。</li>
  <li><strong>リポジトリのオーナー</strong>：「GitHub リポジトリにインストールする」から、issue を作りたいリポジトリに GitHub App をインストールします。一度インストールすれば、どの Discord サーバーからでも使えます。</li>
</ol>

<h2>使い方</h2>
<ol>
  <li>issue にしたい会話があるチャンネルで <code>/issue</code> を実行します。</li>
  <li>初回だけ「GitHub と連携する」ボタンから GitHub アカウントを連携します。確認ページで、連携先の Discord アカウントを確かめてから「連携する」を押してください。</li>
  <li>リポジトリと、要約したいメッセージを選びます。</li>
  <li>要約のプレビューを確認して「✅ 作成する」を押します。「✏️ 編集」で手直し、「🔄 再生成」で要約し直しもできます。</li>
</ol>
<p><code>/issue count:10</code> のように、表示するメッセージ数（最大 25 件）を指定できます。Bot の表示は、実行した本人にしか見えません。</p>

<h2>使えるリポジトリ</h2>
<ul>
  <li>GitHub App がインストールされていて、あなたが権限（collaborator や組織のメンバーなど）を持つリポジトリだけが表示されます。</li>
  <li>issue はあなたの GitHub アカウントの名義で作成されます。</li>
  <li>リポジトリが表示されないときは、リポジトリのオーナーに GitHub App をインストールしてもらってください。インストール済みでも、対象のリポジトリを絞っている場合は追加が必要です。</li>
</ul>

<h2>扱うデータ</h2>
<ul>
  <li>選んだメッセージは、要約のために Cloudflare Workers AI に送られます。issue 本文には、発言者の名前・メッセージ本文・メッセージへのリンクが転記されます。</li>
  <li><strong>公開リポジトリの場合、転記した内容はインターネット上の誰でも読めます。</strong>他の人の発言や個人的な内容を含めるときは注意してください。</li>
  <li>連携のために GitHub のアクセストークンを保存します。<code>/issue-unlink</code> で連携を解除すると、トークンも無効になります。</li>
</ul>`,
  );
}

export function errorPage(err: unknown): Response {
  console.error(err);
  const detail = err instanceof Error ? err.message : '不明なエラー';
  return page('連携に失敗したよ', `<p>${escapeHtml(detail)}</p><p>Discord に戻って、もう一度 <code>/issue</code> を実行してね。</p>`, 500);
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #ffffff; --border: #d1d9e0; --accent: #5865f2; --code-bg: #f0f2f4; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e6edf3; --muted: #9198a1; --bg: #0d1117; --border: #3d444d; --accent: #7983f5; --code-bg: #262c36; }
  }
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.7; color: var(--fg); background: var(--bg); }
  h2 { margin-top: 2.5rem; padding-bottom: 0.25rem; border-bottom: 1px solid var(--border); font-size: 1.25rem; }
  a { color: var(--accent); }
  code { background: var(--code-bg); padding: 0.1rem 0.35rem; border-radius: 4px; }
  .lead { color: var(--muted); }
  .actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 1.5rem 0; }
  .button { display: inline-block; padding: 0.6rem 1.25rem; border-radius: 6px; background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; }
  .button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  button { font: inherit; padding: 0.5rem 1.25rem; margin-right: 0.5rem; cursor: pointer; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // 確認ボタンを別サイトに埋め込んで押させる攻撃を防ぐ
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
