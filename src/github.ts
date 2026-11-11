import type { InstallInfo, IssueRef, IssueSummary, RepoInfo } from './session.js';

export const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/issue-discordbot/installations/new';

type ApiInstallation = { id: number; account: { login?: string; slug?: string } | null };
type ApiRepository = {
  name: string;
  full_name: string;
  owner: { login: string };
  archived: boolean;
  has_issues: boolean;
  permissions?: { pull?: boolean };
};

export type IssueTemplate = { path: string; content: string };

export type IssueTemplates = {
  // テンプレートの出どころ。リポジトリ自体なら 'repo'、オーナーの .github の既定なら 'owner/.github'
  source: string | null;
  templates: IssueTemplate[];
};

const TEMPLATE_DIR = '.github/ISSUE_TEMPLATE';
// ISSUE_TEMPLATE ディレクトリを持たないリポジトリは、旧形式の単一ファイルを置いていることがある
const LEGACY_TEMPLATE_PATHS = ['.github/ISSUE_TEMPLATE.md', 'ISSUE_TEMPLATE.md', 'docs/ISSUE_TEMPLATE.md'];
const MAX_TEMPLATES = 10;

// token が null のときは認証なしで呼ぶ（公開リポジトリの読み取り用）
async function githubFetch(token: string | null, method: string, path: string, body?: unknown, accept?: string) {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub API は User-Agent のないリクエストを拒否する
      'User-Agent': 'discord-issue-bot',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function github<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await githubFetch(token, method, path, body);
  if (!res.ok) throw new Error(`GitHub API エラー: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// 404 は「そのファイル／ディレクトリが無い」として null を返す
async function getContents(token: string | null, path: string, raw: boolean): Promise<Response | null> {
  const res = await githubFetch(token, 'GET', path, undefined, raw ? 'application/vnd.github.raw+json' : undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API エラー: ${res.status} ${await res.text()}`);
  return res;
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

// GitHub と同じ優先順位で探す。リポジトリ自体の ISSUE_TEMPLATE にテンプレートか config.yml が
// 1 つでもあれば、オーナーの .github の既定はまるごと使われない
export async function listIssueTemplates(token: string, owner: string, repo: string): Promise<IssueTemplates> {
  const own = await readTemplateDir(token, owner, repo);
  if (own) return { source: 'repo', templates: own };

  const legacy = await readTemplateFiles(token, owner, repo, LEGACY_TEMPLATE_PATHS);
  if (legacy.length > 0) return { source: 'repo', templates: legacy };

  if (repo === '.github') return { source: null, templates: [] };
  // 既定用の .github は公開が必須なので、App が入っておらずユーザートークンで読めなくても認証なしで読める
  const defaults =
    (await readTemplateDir(token, owner, '.github').catch(() => null)) ??
    (await readTemplateDir(null, owner, '.github').catch(() => null));
  return defaults ? { source: `${owner}/.github`, templates: defaults } : { source: null, templates: [] };
}

// Markdown テンプレートは front matter に name / about、issue form は YAML のトップレベルに name / description を書く。
// 入れ子の項目はインデントされているので、行頭のキーだけを拾えばトップレベルの値になる
export function describeTemplate(template: IssueTemplate): { name: string; description?: string } {
  const field = (key: string) =>
    template.content
      .match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'))?.[1]
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  return {
    name: field('name') || template.path.split('/').pop() || template.path,
    description: field('about') || field('description'),
  };
}

function contentsPath(owner: string, repo: string, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
}

// ディレクトリが無い、またはテンプレートも config.yml も無ければ null
async function readTemplateDir(token: string | null, owner: string, repo: string): Promise<IssueTemplate[] | null> {
  const dir = await getContents(token, contentsPath(owner, repo, TEMPLATE_DIR), false);
  const entries = dir ? ((await dir.json()) as unknown) : null;
  if (!Array.isArray(entries)) return null;

  const files = (entries as Array<{ type: string; name: string; path: string }>).filter(
    (e) => e.type === 'file' && /\.(md|ya?ml)$/i.test(e.name),
  );
  // config.yml はテンプレート選択画面の設定で、テンプレートではない
  const isConfig = (name: string) => /^config\.ya?ml$/i.test(name);
  if (files.length === 0) return null;

  const paths = files
    .filter((e) => !isConfig(e.name))
    .map((e) => e.path)
    .slice(0, MAX_TEMPLATES);
  return readTemplateFiles(token, owner, repo, paths);
}

async function readTemplateFiles(
  token: string | null,
  owner: string,
  repo: string,
  paths: string[],
): Promise<IssueTemplate[]> {
  const templates = await Promise.all(
    paths.map(async (path) => {
      const res = await getContents(token, contentsPath(owner, repo, path), true);
      return res ? { path, content: await res.text() } : null;
    }),
  );
  return templates.filter((t): t is IssueTemplate => t !== null);
}

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export async function createIssue(token: string, owner: string, repo: string, title: string, body: string): Promise<string> {
  const issue = await github<{ html_url: string }>(token, 'POST', `${repoPath(owner, repo)}/issues`, { title, body });
  return issue.html_url;
}

type ApiIssue = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  updated_at: string;
  pull_request?: unknown;
};

// issues API は PR も issue として返す。PR かどうかは pull_request の有無で分かる
export async function getIssue(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<(IssueRef & { isPullRequest: boolean }) | null> {
  const res = await githubFetch(token, 'GET', `${repoPath(owner, repo)}/issues/${number}`);
  // 410 は削除された issue
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`GitHub API エラー: ${res.status} ${await res.text()}`);
  const issue = (await res.json()) as ApiIssue;
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    url: issue.html_url,
    isPullRequest: issue.pull_request !== undefined,
  };
}

// Discord のセレクトメニューに出せるのは 25 件まで。PR を除いた分が減るので多めに取る
export async function listOpenIssues(token: string, owner: string, repo: string): Promise<IssueSummary[]> {
  const issues = await github<ApiIssue[]>(
    token,
    'GET',
    `${repoPath(owner, repo)}/issues?state=open&sort=updated&direction=desc&per_page=50`,
  );
  return issues
    .filter((i) => i.pull_request === undefined)
    .slice(0, 25)
    .map((i) => ({ number: i.number, title: i.title, updatedAt: i.updated_at }));
}

export async function createComment(token: string, owner: string, repo: string, number: number, body: string): Promise<string> {
  const comment = await github<{ html_url: string }>(token, 'POST', `${repoPath(owner, repo)}/issues/${number}/comments`, {
    body,
  });
  return comment.html_url;
}
