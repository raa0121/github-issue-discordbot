import type { InstallInfo, RepoInfo } from './session.js';

type ApiInstallation = { id: number; account: { login?: string; slug?: string } | null };
type ApiRepository = {
  name: string;
  full_name: string;
  owner: { login: string };
  archived: boolean;
  has_issues: boolean;
  permissions?: { pull?: boolean };
};

async function github<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub API は User-Agent のないリクエストを拒否する
      'User-Agent': 'discord-issue-bot',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub API エラー: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function paginate<K extends string, T>(token: string, path: string, key: K): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const data = await github<Record<K, T[]>>(token, 'GET', `${path}?per_page=100&page=${page}`);
    items.push(...data[key]);
    if (data[key].length < 100) return items;
  }
}

export async function getAuthenticatedUser(token: string): Promise<{ id: number; login: string }> {
  return github(token, 'GET', '/user');
}

// ユーザートークンで呼ぶと、App のインストール先のうちユーザー本人がアクセスできるものだけが返る
export async function listUserInstallations(token: string): Promise<InstallInfo[]> {
  const installs = await paginate<'installations', ApiInstallation>(token, '/user/installations', 'installations');
  return installs.map((i) => ({
    id: i.id,
    account: i.account?.login ?? i.account?.slug ?? `installation-${i.id}`,
  }));
}

// App がアクセスでき、かつユーザーが明示的な権限（collaborator や組織メンバー）を持つリポジトリだけが返る
export async function listUserRepositories(token: string, installationId: number): Promise<RepoInfo[]> {
  const repos = await paginate<'repositories', ApiRepository>(
    token,
    `/user/installations/${installationId}/repositories`,
    'repositories',
  );
  return repos
    .filter((r) => r.permissions?.pull && r.has_issues && !r.archived)
    .map((r) => ({ owner: r.owner.login, name: r.name, fullName: r.full_name }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function createIssue(token: string, owner: string, repo: string, title: string, body: string): Promise<string> {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
  const issue = await github<{ html_url: string }>(token, 'POST', path, { title, body });
  return issue.html_url;
}
