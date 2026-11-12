# issue-discordbot

Discord の会話を AI で要約して、GitHub に issue を作ったり、既存の issue にコメントしたりする Discord Bot です。
Cloudflare Workers 上で、Discord の HTTP Interactions として動きます。

## コマンド

| コマンド | 説明 |
| --- | --- |
| `/issue [count]` | 選んだメッセージを要約して、新しい issue を作る |
| `/issue-comment [issue] [count]` | 選んだメッセージを要約して、既存の issue にコメントする |
| `/issue-unlink` | GitHub アカウントとの連携を解除し、トークンを無効にする |

- `count` は選択肢に出す直近のメッセージ数です（1〜25、既定は 20）。
- `issue` には `https://github.com/owner/repo/issues/12` か `owner/repo#12` を指定します。省略すると、リポジトリを選んでから、最近更新された開いている issue（最大 25 件）から選びます。
- Bot の返答は、実行した本人にしか見えません。

## 流れ

1. 初回は GitHub アカウントとの連携を求められます。GitHub で認可したあと、確認ページで連携先の Discord アカウントを確かめて「連携する」を押します。
2. GitHub App のインストール先（複数あるとき）とリポジトリを選びます。`/issue-comment` では続けて issue を選びます。
3. リポジトリに issue テンプレートが 2 件以上あれば、使うテンプレートを選びます（AI に任せる、使わない、も選べます）。
4. 要約するメッセージを選ぶと、プレビューが出ます。「編集」で手直し、「再生成」で要約し直せます。
5. 「作成する」/「投稿する」で GitHub に送ります。

issue とコメントの本文は、次の形になります。

- AI の要約
- 元のメッセージ（発言者・日時・リンク付き。`<details>` で折りたたむ）
- Discord の会話へのリンクを含む署名

本文中の `@user` には、GitHub でメンションにならないようゼロ幅スペースを挟みます。

### 使えるリポジトリ

GitHub App がインストールされていて、利用者本人が権限を持つリポジトリだけを使えます。issue とコメントは、利用者の GitHub アカウントの名義で投稿されます。

### issue テンプレート

GitHub と同じ順で探します。

1. リポジトリの `.github/ISSUE_TEMPLATE/`
2. リポジトリの `ISSUE_TEMPLATE.md`（`.github/`、ルート、`docs/`）
3. オーナーの `.github` リポジトリの `.github/ISSUE_TEMPLATE/`

テンプレートは最大 10 件まで読み、AI への指示に含めます。タイトルの接頭辞（`[Bug]` など）は付けません。テンプレートの `labels` は反映しません。

## 構成

| 使うもの | 用途 |
| --- | --- |
| Workers AI（`@cf/google/gemma-4-26b-a4b-it`） | 要約 |
| D1 | Discord ユーザーと GitHub アカウントの連携情報（`user_links`） |
| KV | 操作途中のセッションと OAuth の途中状態（どちらも 10 分で消える） |
| Cron Trigger（毎日 JST 3:00） | 期限切れの連携情報を D1 から削除 |

GitHub の API は、GitHub App のユーザーアクセストークンで呼びます。トークンは期限の 5 分前に自動で更新します。

| パス | 内容 |
| --- | --- |
| `GET /` | 導入方法と使い方の案内ページ |
| `GET /github/callback` | GitHub OAuth のコールバック。連携の確認ページを出す |
| `POST /github/confirm` | 確認ページの送信先 |
| `POST`（上記以外） | Discord の Interactions |

```
src/
  index.ts        ルーティング、コマンドとコンポーネントの処理、Discord の UI
  discord.ts      署名の検証、応答の編集
  github.ts       GitHub API（リポジトリ、issue、コメント、テンプレート）
  oauth.ts        GitHub OAuth、連携情報の保存とトークンの更新
  summarize.ts    Workers AI への指示
  issue-body.ts   issue とコメントの本文の組み立て
  session.ts      操作途中のセッション
  web.ts          案内ページと連携の確認ページ
migrations/       D1 のマイグレーション
scripts/          スラッシュコマンドの登録
```

## セットアップ

Node.js と Cloudflare のアカウントが必要です。

```bash
npm install
```

### 1. Cloudflare のリソース

KV と D1 を作り、出力された ID を `wrangler.toml` の `[[kv_namespaces]]` と `[[d1_databases]]` に書きます。

```bash
npx wrangler kv namespace create KV
```

```bash
npx wrangler d1 create discord-issue-bot
```

```bash
npx wrangler d1 migrations apply discord-issue-bot --remote
```

### 2. Discord アプリケーション

[Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを作ります。

- **Bot**: Message Content Intent を有効にします。メッセージの本文を読むために必要です。
- **Installation**: Guild Install の scope に `bot` と `applications.commands`、権限に「チャンネルを見る」と「メッセージ履歴を読む」を指定します。
- **General Information**: Interactions Endpoint URL に Worker の URL（例: `https://discord-issue-bot.<account>.workers.dev`）を設定します。デプロイしてから設定してください。保存するときに Discord が疎通を確かめます。

Application ID と Public Key は `wrangler.toml` の `[vars]` に書きます。

### 3. GitHub App

[GitHub の Developer settings](https://github.com/settings/apps) で GitHub App を作ります。

- **Callback URL**: `https://<Worker のホスト>/github/callback`
- **Expire user authorization tokens**: 有効にします（期限付きトークンと更新用トークンを使います）。
- **Repository permissions**: Issues を Read and write、Contents を Read-only（issue テンプレートを読むため）、Metadata を Read-only にします。
- **Where can this GitHub App be installed?**: 他のアカウントでも使うなら Any account にします。

Client ID は `wrangler.toml` の `[vars]` の `GITHUB_CLIENT_ID` に書きます。
`src/github.ts` の `GITHUB_APP_INSTALL_URL` は、App のインストールページ（`https://github.com/apps/<App の名前>/installations/new`）にします。

### 4. Secret の登録

```bash
npx wrangler secret put DISCORD_TOKEN
```

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET
```

| 名前 | 内容 |
| --- | --- |
| `DISCORD_TOKEN` | Discord の Bot トークン。メッセージ履歴の取得に使う |
| `GITHUB_CLIENT_SECRET` | GitHub App の Client secret |

### 5. デプロイとコマンドの登録

```bash
npm run deploy
```

コマンドの登録には、`.dev.vars` に `DISCORD_APPLICATION_ID` と `DISCORD_TOKEN` を書いておきます。コマンドの定義を変えたときも、もう一度実行します。

```bash
npm run register
```

## 開発

ローカルで動かすときは、`.dev.vars` に Secret と同じ名前で値を書きます。`.dev.vars` はコミットしません。

```bash
npm run dev
```

Discord からローカルに届くようにするには、cloudflared などで公開した URL を Interactions Endpoint URL に設定します。

```bash
npm run typecheck
```
