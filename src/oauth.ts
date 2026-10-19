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

export async function getLink(kv: KVNamespace, discordUserId: string): Promise<UserLink | null> {
  const raw = await kv.get(`user:${discordUserId}`);
  return raw ? JSON.parse(raw) : null;
}

export async function saveLink(kv: KVNamespace, discordUserId: string, link: UserLink): Promise<void> {
  // リフレッシュトークンが切れたら連携は使えないので、同じタイミングで KV からも消えるようにする
  const ttl = link.refreshExpiresAt ? Math.floor((link.refreshExpiresAt - Date.now()) / 1000) : undefined;
  await kv.put(`user:${discordUserId}`, JSON.stringify(link), ttl ? { expirationTtl: Math.max(60, ttl) } : undefined);
}

export async function deleteLink(kv: KVNamespace, discordUserId: string): Promise<void> {
  await kv.delete(`user:${discordUserId}`);
}

// 連携がない、または更新できなくなった場合は null を返す
export async function getUserToken(env: Env, discordUserId: string): Promise<string | null> {
  const link = await getLink(env.KV, discordUserId);
  if (!link) return null;
  if (!link.expiresAt || link.expiresAt - Date.now() > REFRESH_MARGIN_MS) return link.accessToken;
  if (!link.refreshToken) {
    await deleteLink(env.KV, discordUserId);
    return null;
  }

  try {
    const tokens = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: link.refreshToken });
    await saveLink(env.KV, discordUserId, { ...link, ...tokens });
    return tokens.accessToken;
  } catch (err) {
    console.error(err);
    // リフレッシュトークンは使い捨てなので、同時に走った別リクエストが先に更新していればそちらを使う
    const latest = await getLink(env.KV, discordUserId);
    if (latest && latest.accessToken !== link.accessToken) return latest.accessToken;
    await deleteLink(env.KV, discordUserId);
    return null;
  }
}
