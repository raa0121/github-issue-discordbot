import type { IssueTemplate } from './github.js';

const MODEL = '@cf/google/gemma-4-26b-a4b-it';

const ISSUE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['title', 'body'],
};

// 巨大なテンプレートでプロンプトが膨らまないよう、1 件あたりの長さを抑える
const TEMPLATE_CHAR_LIMIT = 4000;

export async function summarize(
  ai: Ai,
  transcript: string,
  templates: IssueTemplate[],
): Promise<{ title: string; body: string }> {
  const res = await ai.run(MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'あなたは優秀なプロジェクトマネージャーです。Discord の会話を読んで、GitHub issue のタイトルと本文を作成してください。',
      },
      {
        role: 'user',
        content: [
          '以下は Discord の会話ログです。',
          '内容を簡潔に要約し、議題・決定事項・次のアクション（あれば）を含む GitHub issue を作成してください。',
          'body は Markdown で書いてください。',
          '出力は必ず JSON 形式で { "title": "...", "body": "..." } としてください。',
          ...templateInstructions(templates),
          '',
          '--- 会話ログ ここから ---',
          transcript,
          '--- 会話ログ ここまで ---',
        ].join('\n'),
      },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'github_issue', schema: ISSUE_SCHEMA } },
    // 要約に推論は不要で、有効だと waitUntil の 30 秒制限に近づくため切る
    chat_template_kwargs: { enable_thinking: false },
  });

  const raw = res.choices[0]?.message.content ?? '{}';
  try {
    const parsed = JSON.parse(stripCodeFence(raw));
    return { title: parsed.title || '要約 issue', body: parsed.body || parsed.summary || '（要約なし）' };
  } catch {
    return { title: '要約 issue', body: raw };
  }
}

function templateInstructions(templates: IssueTemplate[]): string[] {
  if (templates.length === 0) return [];
  return [
    '',
    'issue を作るリポジトリには、以下の issue テンプレートがあります。上の構成よりテンプレートを優先してください。',
    '- 会話の内容に最も合うテンプレートを 1 つ選び、その見出し構成と記入項目に沿って body を書いてください。',
    '- YAML の issue form の場合は、各入力項目の label を見出しにして、その下に内容を書いてください。',
    '- テンプレートの front matter や title 項目にタイトルの書式（接頭辞など）があれば、title もそれに合わせてください。',
    '- 会話から分からない項目は推測で埋めず、「不明」と書いてください。',
    '- テンプレート内のコメント（<!-- -->）や記入例は body に残さないでください。',
    ...templates.flatMap((t) => [
      '',
      `--- テンプレート ${t.path} ここから ---`,
      t.content.length > TEMPLATE_CHAR_LIMIT ? `${t.content.slice(0, TEMPLATE_CHAR_LIMIT)}\n（以下省略）` : t.content,
      `--- テンプレート ${t.path} ここまで ---`,
    ]),
  ];
}

// JSON モードの対応モデル一覧に載っていないモデルなので、```json で囲んで返してくる場合に備える
function stripCodeFence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : text;
}
