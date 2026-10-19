import { App } from '@octokit/app';
import type { Env } from './env.js';
import type { InstallInfo, RepoInfo } from './session.js';

export function createGitHubApp(env: Env) {
  return new App({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n') });
}

export async function listInstallations(app: App): Promise<InstallInfo[]> {
  const installs: InstallInfo[] = [];
  for await (const { installation } of app.eachInstallation.iterator()) {
    installs.push({
      id: installation.id,
      account: installation.account?.login ?? `installation-${installation.id}`,
    });
  }
  return installs;
}

export async function listRepositories(app: App, installationId: number): Promise<RepoInfo[]> {
  const repos: RepoInfo[] = [];
  for await (const { repository } of app.eachRepository.iterator({ installationId })) {
    repos.push({ owner: repository.owner.login, name: repository.name, fullName: repository.full_name });
  }
  return repos;
}

export async function createIssue(
  app: App,
  installationId: number,
  owner: string,
  repo: string,
  title: string,
  body: string,
): Promise<string> {
  const octokit = await app.getInstallationOctokit(installationId);
  const { data } = await octokit.request('POST /repos/{owner}/{repo}/issues', { owner, repo, title, body });
  return data.html_url;
}
