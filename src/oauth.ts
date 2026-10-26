import type { Env } from './env.js';

export const CALLBACK_PATH = '/github/callback';
export const CONFIRM_PATH = '/github/confirm';

const STATE_TTL_SECONDS = 600;
// 期限ぎりぎりのトークンで API を呼ぶと途中で失効するので、余裕を持って更新する
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type Tokens = {
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
};

export type UserLink = Tokens & { githubId: number; githubLogin: string };

export type DiscordUser = { id: string; name: string };

export type OAuthState = { discordUser: DiscordUser };

export type PendingLink = { discordUser: DiscordUser; link: UserLink };

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
};

export function authorizeUrl(env: Env, state: string, redirectUri: string): string {
  const params = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: redirectUri, state });
  return `https://github.com/login/oauth/authorize?${params}`;
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<Tokens> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
  });
  const data = (await res.json()) as TokenResponse;
  // 失敗しても 200 で error フィールドを返してくることがある
  if (!res.ok || !data.access_token) {
    throw new Error(`GitHub の認可に失敗したよ: ${data.error_description ?? data.error ?? res.status}`);
  }
  const now = Date.now();
  return {
    accessToken: data.access_token,
    expiresAt: data.expires_in ? now + data.expires_in * 1000 : undefined,
    refreshToken: data.refresh_token,
    refreshExpiresAt: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1000 : undefined,
  };
}

export function exchangeCode(env: Env, code: string, redirectUri: string): Promise<Tokens> {
  return tokenRequest(env, { code, redirect_uri: redirectUri });
}

export async function revokeToken(env: Env, accessToken: string): Promise<void> {
  const res = await fetch(`https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`, {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'discord-issue-bot',
    },
    body: JSON.stringify({ access_token: accessToken }),
  });
  // 404 は既に失効済み
  if (!res.ok && res.status !== 404) throw new Error(`トークンの取り消しに失敗したよ: ${res.status}`);
}

// ---------- KV ----------

export async function createOAuthState(kv: KVNamespace, discordUser: DiscordUser): Promise<string> {
  const state = crypto.randomUUID();
  const value: OAuthState = { discordUser };
  await kv.put(`oauth_state:${state}`, JSON.stringify(value), { expirationTtl: STATE_TTL_SECONDS });
  return state;
}

export async function consumeOAuthState(kv: KVNamespace, state: string): Promise<OAuthState | null> {
  return consume<OAuthState>(kv, `oauth_state:${state}`);
}

export async function createPendingLink(kv: KVNamespace, pending: PendingLink): Promise<string> {
  const nonce = crypto.randomUUID();
  await kv.put(`oauth_pending:${nonce}`, JSON.stringify(pending), { expirationTtl: STATE_TTL_SECONDS });
  return nonce;
}

export async function consumePendingLink(kv: KVNamespace, nonce: string): Promise<PendingLink | null> {
  return consume<PendingLink>(kv, `oauth_pending:${nonce}`);
}

async function consume<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  await kv.delete(key);
  return JSON.parse(raw);
}

// ---------- D1（連携情報） ----------
// 連携情報は KV に置くと、別の拠点で「無い」とキャッシュされた結果が連携直後も残り、連携し直しを求めてしまう。
// D1 は書き込み直後からどの拠点でも読めるのでこちらに置く

type LinkRow = {
  github_id: number;
  github_login: string;
  access_token: string;
  expires_at: number | null;
  refresh_token: string | null;
  refresh_expires_at: number | null;
};

export async function getLink(env: Env, discordUserId: string): Promise<UserLink | null> {
  const row = await env.DB.prepare(
    `SELECT github_id, github_login, access_token, expires_at, refresh_token, refresh_expires_at
       FROM user_links WHERE discord_user_id = ?`,
  )
    .bind(discordUserId)
    .first<LinkRow>();
  if (!row) return migrateLinkFromKv(env, discordUserId);
  return {
    githubId: row.github_id,
    githubLogin: row.github_login,
    accessToken: row.access_token,
    expiresAt: row.expires_at ?? undefined,
    refreshToken: row.refresh_token ?? undefined,
    refreshExpiresAt: row.refresh_expires_at ?? undefined,
  };
}

export async function saveLink(env: Env, discordUserId: string, link: UserLink): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_links
       (discord_user_id, github_id, github_login, access_token, expires_at, refresh_token, refresh_expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (discord_user_id) DO UPDATE SET
       github_id = excluded.github_id,
       github_login = excluded.github_login,
       access_token = excluded.access_token,
       expires_at = excluded.expires_at,
       refresh_token = excluded.refresh_token,
       refresh_expires_at = excluded.refresh_expires_at,
       updated_at = excluded.updated_at`,
  )
    .bind(
      discordUserId,
      link.githubId,
      link.githubLogin,
      link.accessToken,
      link.expiresAt ?? null,
      link.refreshToken ?? null,
      link.refreshExpiresAt ?? null,
      Date.now(),
    )
    .run();
}

export async function deleteLink(env: Env, discordUserId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM user_links WHERE discord_user_id = ?').bind(discordUserId).run();
  await env.KV.delete(`user:${discordUserId}`);
}

// リフレッシュトークンまで切れた連携は二度と使えないので消す。期限のないトークンの行は残す
export async function deleteExpiredLinks(env: Env): Promise<number> {
  const result = await env.DB.prepare('DELETE FROM user_links WHERE COALESCE(refresh_expires_at, expires_at) < ?')
    .bind(Date.now())
    .run();
  return result.meta.changes;
}

// KV の user:<id> には D1 導入前に連携したユーザーの情報が残っている。次に使われたときに D1 へ移す。
// KV 側はリフレッシュトークンの期限（約半年）で自動的に消えるので、2027 年 5 月以降はこの処理ごと消してよい
async function migrateLinkFromKv(env: Env, discordUserId: string): Promise<UserLink | null> {
  const raw = await env.KV.get(`user:${discordUserId}`);
  if (!raw) return null;
  const link = JSON.parse(raw) as UserLink;
  await saveLink(env, discordUserId, link);
  await env.KV.delete(`user:${discordUserId}`);
  return link;
}

// 連携がない、または更新できなくなった場合は null を返す
export async function getUserToken(env: Env, discordUserId: string): Promise<string | null> {
  const link = await getLink(env, discordUserId);
  if (!link) return null;
  if (!link.expiresAt || link.expiresAt - Date.now() > REFRESH_MARGIN_MS) return link.accessToken;
  if (!link.refreshToken || (link.refreshExpiresAt && link.refreshExpiresAt < Date.now())) {
    await deleteLink(env, discordUserId);
    return null;
  }

  try {
    const tokens = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: link.refreshToken });
    await saveLink(env, discordUserId, { ...link, ...tokens });
    return tokens.accessToken;
  } catch (err) {
    console.error(err);
    // リフレッシュトークンは使い捨てなので、同時に走った別リクエストが先に更新していればそちらを使う
    const latest = await getLink(env, discordUserId);
    if (latest && latest.accessToken !== link.accessToken) return latest.accessToken;
    await deleteLink(env, discordUserId);
    return null;
  }
}
