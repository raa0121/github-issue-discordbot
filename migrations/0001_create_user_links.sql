CREATE TABLE user_links (
  discord_user_id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  access_token TEXT NOT NULL,
  -- ミリ秒の UNIX 時刻。トークンに期限がない設定の GitHub App では NULL
  expires_at INTEGER,
  refresh_token TEXT,
  refresh_expires_at INTEGER,
  updated_at INTEGER NOT NULL
);
