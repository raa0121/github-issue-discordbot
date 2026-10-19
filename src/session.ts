export type MessageEntry = {
  id: string;
  author: string;
  content: string;
  url: string;
  createdAt: string;
};

export type InstallInfo = { id: number; account: string };

export type RepoInfo = { owner: string; name: string; fullName: string };

export type Session =
  | { step: 'install'; installs: InstallInfo[]; count: number }
  | { step: 'repo'; installationId: number; repos: RepoInfo[]; page: number; count: number }
  | { step: 'messages'; repo: RepoInfo & { installationId: number }; messages: MessageEntry[] }
  | {
      step: 'preview';
      repo: RepoInfo & { installationId: number };
      messages: MessageEntry[];
      title: string;
      body: string;
    };

export type SessionOf<S extends Session['step']> = Extract<Session, { step: S }>;

export async function getSession(kv: KVNamespace, sessionId: string): Promise<Session | null> {
  const raw = await kv.get(`session:${sessionId}`);
  return raw ? JSON.parse(raw) : null;
}

export async function setSession(kv: KVNamespace, sessionId: string, session: Session, ttlSeconds = 600) {
  await kv.put(`session:${sessionId}`, JSON.stringify(session), { expirationTtl: ttlSeconds });
}

export async function deleteSession(kv: KVNamespace, sessionId: string) {
  await kv.delete(`session:${sessionId}`);
}
