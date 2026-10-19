const MODEL = '@cf/google/gemma-4-26b-a4b-it';

const ISSUE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['title', 'body'],
};

export async function summarize(ai: Ai, transcript: string): Promise<{ title: string; body: string }> {
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
          '',
          '---',
          transcript,
          '---',
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

// JSON モードの対応モデル一覧に載っていないモデルなので、```json で囲んで返してくる場合に備える
function stripCodeFence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : text;
}
