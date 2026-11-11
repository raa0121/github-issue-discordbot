import type { IssueTemplate } from './github.js';
import type { IssueRef } from './session.js';

const MODEL = '@cf/google/gemma-4-26b-a4b-it';

const ISSUE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['title', 'body'],
};

const COMMENT_SCHEMA = {
  type: 'object',
  properties: { body: { type: 'string' } },
  required: ['body'],
};

// 巨大なテンプレートや issue 本文でプロンプトが膨らまないよう、1 件あたりの長さを抑える
const TEMPLATE_CHAR_LIMIT = 4000;
const ISSUE_BODY_CHAR_LIMIT = 4000;

const SYSTEM_PROMPT = 'あなたは優秀なプロジェクトマネージャーです。Discord の会話を読んで、GitHub に投稿する文章を作成してください。';

export async function summarize(
  ai: Ai,
  transcript: string,
  templates: IssueTemplate[],
): Promise<{ title: string; body: string }> {
  const prompt = [
    '以下は Discord の会話ログです。',
    '内容を簡潔に要約し、議題・決定事項・次のアクション（あれば）を含む GitHub issue を作成してください。',
    'title は内容が分かる短い 1 行にしてください。「Feature Request: 」「[Bug] 」のような issue の種類を表す接頭辞は付けないでください。',
    'body は Markdown で書いてください。',
    '出力は必ず JSON 形式で { "title": "...", "body": "..." } としてください。',
    ...templateInstructions(templates),
    '',
    ...transcriptSection(transcript),
  ];
  const { parsed, raw } = await generate(ai, prompt, 'github_issue', ISSUE_SCHEMA);
  return {
    title: str(parsed?.title) || '要約 issue',
    body: parsed ? str(parsed.body) || str(parsed.summary) || '（要約なし）' : raw,
  };
}

export async function summarizeForComment(ai: Ai, transcript: string, issue: IssueRef): Promise<string> {
  const issueBody =
    issue.body.length > ISSUE_BODY_CHAR_LIMIT ? `${issue.body.slice(0, ISSUE_BODY_CHAR_LIMIT)}\n（以下省略）` : issue.body;
  const prompt = [
    `以下は、GitHub issue #${issue.number}「${issue.title}」について Discord で話した会話ログです。`,
    'この issue に追記するコメントとして、会話の内容を簡潔に要約してください。',
    'issue に書かれていることは繰り返さず、新しく分かったこと・決まったこと・次のアクション（あれば）を中心に書いてください。',
    'body は Markdown で書いてください。',
    '出力は必ず JSON 形式で { "body": "..." } としてください。',
    '',
    '--- issue の本文 ここから ---',
    issueBody || '（本文なし）',
    '--- issue の本文 ここまで ---',
    '',
    ...transcriptSection(transcript),
  ];
  const { parsed, raw } = await generate(ai, prompt, 'github_comment', COMMENT_SCHEMA);
  return parsed ? str(parsed.body) || '（要約なし）' : raw;
}

function transcriptSection(transcript: string): string[] {
  return ['--- 会話ログ ここから ---', transcript, '--- 会話ログ ここまで ---'];
}

// JSON として読めなければ parsed は null。呼び出し側で生の出力を本文として使う
async function generate(
  ai: Ai,
  prompt: string[],
  schemaName: string,
  schema: Record<string, unknown>,
): Promise<{ parsed: Record<string, unknown> | null; raw: string }> {
  const res = await ai.run(MODEL, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt.join('\n') },
    ],
    response_format: { type: 'json_schema', json_schema: { name: schemaName, schema } },
    // 要約に推論は不要で、有効だと waitUntil の 30 秒制限に近づくため切る
    chat_template_kwargs: { enable_thinking: false },
  });

  const raw = res.choices[0]?.message.content ?? '{}';
  try {
    const parsed = JSON.parse(stripCodeFence(raw));
    return { parsed: parsed && typeof parsed === 'object' ? parsed : null, raw };
  } catch {
    return { parsed: null, raw };
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function templateInstructions(templates: IssueTemplate[]): string[] {
  if (templates.length === 0) return [];
  return [
    '',
    'issue を作るリポジトリには、以下の issue テンプレートがあります。上の構成よりテンプレートを優先してください。',
    '- 会話の内容に最も合うテンプレートを 1 つ選び、その見出し構成と記入項目に沿って body を書いてください。',
    '- YAML の issue form の場合は、各入力項目の label を見出しにして、その下に内容を書いてください。',
    // 「テンプレートを優先」と指示しているため、ここでも打ち消さないとテンプレートの接頭辞に従ってしまう
    '- テンプレートの front matter や title 項目に接頭辞があっても、title には付けないでください。issue の種類はラベルで分かります。',
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
