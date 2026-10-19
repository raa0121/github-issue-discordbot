const { DISCORD_APPLICATION_ID, DISCORD_TOKEN } = process.env;
if (!DISCORD_APPLICATION_ID || !DISCORD_TOKEN) {
  console.error('DISCORD_APPLICATION_ID と DISCORD_TOKEN を設定してね。');
  process.exit(1);
}

const commands = [
  {
    name: 'issue',
    description: 'Discord の会話を要約して GitHub issue を作成します',
    type: 1,
    // メッセージ履歴の取得に Bot トークンを使うので、Bot が参加しているサーバー内に限定する
    contexts: [0],
    options: [
      {
        type: 4,
        name: 'count',
        description: '表示する直近メッセージ数（最大25件）',
        min_value: 1,
        max_value: 25,
      },
    ],
  },
];

const res = await fetch(`https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error(`登録に失敗したよ: ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log('✅ スラッシュコマンドを登録したよ！');
