import type { Env } from './env.js';
import { getAuthenticatedUser } from './github.js';
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
    `<p>GitHub の <strong>${escapeHtml(pending.link.githubLogin)}</strong> と連携したよ。Discord に戻って、もう一度 <code>/issue</code> を実行してね。</p>`,
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
  body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.7; }
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
