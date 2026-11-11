import type { MessageEntry } from './session.js';

// GitHub の issue 本文の上限は 65,536 文字。数え方の差に備えて少し手前に収める
const BODY_LIMIT = 65_000;
const SUMMARY_LIMIT = 30_000;
const TRUNCATED_MARK = '…（長いため省略。全文はリンク先の Discord を参照）';

export function buildIssueBody(summary: string, messages: MessageEntry[]): string {
  const head = [truncate(escapeMentions(summary), SUMMARY_LIMIT), '', '## 元チャット', '', ''].join('\n');
  const contents = messages.map((m) => escapeMentions(m.content));
  const footer = `\n\n---\n<sub>🤖 [Discord の会話](${messages[0].url}) から issue-discordbot で作成</sub>`;
  const render = (cap: number) => head + sourceChatDetails(messages, contents, cap) + footer;

  const full = render(Infinity);
  if (full.length <= BODY_LIMIT) return full;

  // 1 件あたりの上限を共通にして、収まる最大値を二分探索する。短いメッセージは削られず、長いものから削られる
  let lo = 0;
  let hi = Math.max(...contents.map((c) => c.length));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (render(mid).length <= BODY_LIMIT) lo = mid;
    else hi = mid - 1;
  }
  return render(lo);
}

// GitHub は @ の直後が英数字だとユーザー / チームへのメンションとして通知を飛ばす。
// ゼロ幅スペースを挟み、見た目を変えずにメンションにならないようにする。
// メールアドレスや URL 中の /@user はメンションにならないので触らない
export function escapeMentions(text: string): string {
  return text.replace(/(?<![\w/])@(?=[A-Za-z0-9])/g, '@​');
}

// <summary> の直後と </details> の直前に空行がないと、GitHub は中身を Markdown として描画しない
function sourceChatDetails(messages: MessageEntry[], contents: string[], cap: number): string {
  const entries = messages.map((m, i) => {
    const content = contents[i].length > cap ? `${truncate(contents[i], cap, '')}\n${TRUNCATED_MARK}` : contents[i];
    const quoted = content
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return `**${escapeMentions(m.author)}** · [${formatJst(m.createdAt)}](${m.url})\n\n${quoted}`;
  });
  return [
    '<details>',
    `<summary>${messages.length} 件のメッセージ</summary>`,
    '',
    entries.join('\n\n'),
    '',
    '</details>',
  ].join('\n');
}

export function formatJst(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short' });
}

function truncate(str: string, max: number, mark = '…'): string {
  if (str.length <= max) return str;
  let end = Math.max(0, max - mark.length);
  // サロゲートペアの途中で切ると不正な文字が残る
  if (end > 0 && /[\uD800-\uDBFF]/.test(str[end - 1])) end--;
  return str.slice(0, end) + mark;
}
