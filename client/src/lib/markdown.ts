/**
 * Lightweight markdown for chat messages. The parser turns text into a small tree
 * (never HTML): fenced code blocks, inline code, **bold**, *italic* / _italic_,
 * ||spoilers||, http(s) links and @mentions, with line breaks kept. Everything
 * the author typed stays text; nothing is ever interpreted as markup other than
 * these few markers, and a backslash escapes any of them (\*, \_, \`, \|, \\).
 * MessageBody renders the tree with Preact elements, so there is no sanitising
 * step to get wrong: there is no HTML to begin with.
 */
import { sanitizeUrl } from './text';

export interface MentionName {
  accountId: string;
  /** The name as it appears in the text after the @ (display name or username). */
  name: string;
}

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'break' }
  | { type: 'code'; value: string }
  | { type: 'bold'; children: InlineNode[] }
  | { type: 'italic'; children: InlineNode[] }
  | { type: 'spoiler'; children: InlineNode[] }
  | { type: 'link'; href: string; value: string }
  | { type: 'mention'; value: string; accountId: string | null };

export type BlockNode = { type: 'paragraph'; children: InlineNode[] } | { type: 'codeblock'; language: string | null; value: string };

export interface MarkdownOptions {
  /** Mentions the server resolved for the message: these names are matched exactly (spaces included). */
  mentions?: readonly MentionName[];
}

const ESCAPABLE = new Set(['\\', '*', '_', '`', '|', '~']);
const URL_PATTERN = /^https?:\/\/[^\s<>"'`]+/i;
/** Characters that end a sentence more often than a link: not part of a trailing URL. */
const URL_TRAIL = /[.,;:!?'"]+$/;
const NAME_CHAR = /[\p{L}\p{N}_]/u;
const FALLBACK_MENTION = /^@[\p{L}\p{N}_.-]+/u;
const FENCE = /^```[ \t]*([\w+#.-]{0,32})[ \t]*$/;

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);
const isNameChar = (ch: string | undefined): boolean => ch !== undefined && NAME_CHAR.test(ch);

/** Index of `marker` in `src` at or after `from`, on the same line; -1 when absent. */
const findOnLine = (src: string, marker: string, from: number): number => {
  const index = src.indexOf(marker, from);
  if (index === -1) return -1;
  const newline = src.indexOf('\n', from);
  return newline !== -1 && newline < index ? -1 : index;
};

/**
 * The closing `marker` for a span opened at `start` (just after the opener): the
 * content must be non-empty, start and end with a non-space character, and
 * stay on one line. -1 when there is none.
 */
const findCloser = (src: string, marker: string, start: number): number => {
  if (isSpace(src[start])) return -1;
  let from = start + 1;
  for (;;) {
    const index = findOnLine(src, marker, from);
    if (index === -1) return -1;
    if (!isSpace(src[index - 1]) && src[index - 1] !== '\\') return index;
    from = index + 1;
  }
};

/** The URL starting at `index`, trailing punctuation left out; null when it is not one we link. */
const matchUrl = (src: string, index: number): { value: string; href: string } | null => {
  const match = URL_PATTERN.exec(src.slice(index));
  if (!match) return null;
  let value = match[0].replace(URL_TRAIL, '');
  // A link written inside parentheses keeps its own balanced ones only.
  while (value.endsWith(')') && (value.match(/\(/g) ?? []).length < (value.match(/\)/g) ?? []).length) value = value.slice(0, -1);
  const href = sanitizeUrl(value);
  return href ? { value, href } : null;
};

/** The mention starting at the `@` at `index`: a resolved name first (longest wins), else a plain @word. */
const matchMention = (src: string, index: number, mentions: readonly MentionName[]): { value: string; accountId: string | null } | null => {
  let best: { value: string; accountId: string | null } | null = null;
  for (const mention of mentions) {
    const needle = '@' + mention.name;
    if (!needle.length || src.length < index + needle.length) continue;
    if (src.slice(index, index + needle.length).toLowerCase() !== needle.toLowerCase()) continue;
    if (isNameChar(src[index + needle.length])) continue;
    if (!best || needle.length > best.value.length) best = { value: src.slice(index, index + needle.length), accountId: mention.accountId };
  }
  if (best) return best;
  const plain = FALLBACK_MENTION.exec(src.slice(index));
  if (!plain) return null;
  const value = plain[0].replace(/[.-]+$/, '');
  return value.length > 1 ? { value, accountId: null } : null;
};

const parseInline = (src: string, mentions: readonly MentionName[]): InlineNode[] => {
  const out: InlineNode[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ type: 'text', value: text });
    text = '';
  };
  /** Emit a styled span and return the index after its closing marker. */
  const span = (type: 'bold' | 'italic' | 'spoiler', inner: string, close: number) => {
    flush();
    out.push({ type, children: parseInline(inner, mentions) });
    return close + (type === 'italic' ? 1 : 2);
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') {
      flush();
      out.push({ type: 'break' });
      i += 1;
      continue;
    }
    if (ch === '\\' && ESCAPABLE.has(src[i + 1] ?? '')) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      // A run of backticks opens a code span closed by a run of the same length (so `` a`b `` works).
      let run = 1;
      while (src[i + run] === '`') run += 1;
      const marker = '`'.repeat(run);
      const end = findOnLine(src, marker, i + run);
      if (end > i + run) {
        flush();
        out.push({ type: 'code', value: src.slice(i + run, end) });
        i = end + run;
        continue;
      }
      text += marker;
      i += run;
      continue;
    }
    if (src.startsWith('**', i)) {
      const end = findCloser(src, '**', i + 2);
      if (end !== -1) {
        i = span('bold', src.slice(i + 2, end), end);
        continue;
      }
    }
    if (src.startsWith('||', i)) {
      const end = findCloser(src, '||', i + 2);
      if (end !== -1) {
        i = span('spoiler', src.slice(i + 2, end), end);
        continue;
      }
    }
    if (ch === '*' && src[i + 1] !== '*') {
      const end = findCloser(src, '*', i + 1);
      if (end !== -1 && src[end + 1] !== '*') {
        i = span('italic', src.slice(i + 1, end), end);
        continue;
      }
    }
    // Underscores italicise only as whole words, so snake_case names stay as typed.
    if (ch === '_' && !isNameChar(src[i - 1])) {
      const end = findCloser(src, '_', i + 1);
      if (end !== -1 && !isNameChar(src[end + 1])) {
        i = span('italic', src.slice(i + 1, end), end);
        continue;
      }
    }
    if ((ch === 'h' || ch === 'H') && !isNameChar(src[i - 1])) {
      const url = matchUrl(src, i);
      if (url) {
        flush();
        out.push({ type: 'link', href: url.href, value: url.value });
        i += url.value.length;
        continue;
      }
    }
    // "@name" after a word character is an address (bob@example.com), not a mention.
    if (ch === '@' && !isNameChar(src[i - 1])) {
      const mention = matchMention(src, i, mentions);
      if (mention) {
        flush();
        out.push({ type: 'mention', value: mention.value, accountId: mention.accountId });
        i += mention.value.length;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
};

/** Parse a message into blocks: fenced code blocks and paragraphs of inline nodes. */
export const parseMarkdown = (raw: string, options: MarkdownOptions = {}): BlockNode[] => {
  const mentions = options.mentions ?? [];
  const blocks: BlockNode[] = [];
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  const flushParagraph = () => {
    // Blank lines next to a code block (or the ends of the message) carry nothing.
    while (paragraph.length > 0 && paragraph[0].trim() === '') paragraph.shift();
    while (paragraph.length > 0 && paragraph[paragraph.length - 1].trim() === '') paragraph.pop();
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n'), mentions) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const fence = FENCE.exec(lines[index]);
    if (!fence) {
      paragraph.push(lines[index]);
      continue;
    }
    // A fenced block runs to the closing fence, or to the end of the message when there is none.
    let end = index + 1;
    while (end < lines.length && lines[end].trim() !== '```') end += 1;
    flushParagraph();
    blocks.push({ type: 'codeblock', language: fence[1] ? fence[1].toLowerCase() : null, value: lines.slice(index + 1, end).join('\n') });
    index = end;
  }
  flushParagraph();
  return blocks;
};

/** Plain text of the tree (for previews and notifications): markers gone, code kept, spoilers shown. */
export const plainText = (blocks: readonly BlockNode[]): string => {
  const inline = (nodes: readonly InlineNode[]): string =>
    nodes
      .map((node) => {
        switch (node.type) {
          case 'text':
          case 'code':
            return node.value;
          case 'break':
            return '\n';
          case 'link':
          case 'mention':
            return node.value;
          default:
            return inline(node.children);
        }
      })
      .join('');
  return blocks.map((block) => (block.type === 'codeblock' ? block.value : inline(block.children))).join('\n');
};

/**
 * One line of a message for a quote or a preview: markers gone, code kept, line
 * breaks collapsed, and spoilers kept hidden (a quote must not give them away).
 */
export const quoteText = (raw: string): string => {
  const inline = (nodes: readonly InlineNode[]): string =>
    nodes
      .map((node) => {
        switch (node.type) {
          case 'text':
          case 'code':
          case 'link':
          case 'mention':
            return node.value;
          case 'break':
            return ' ';
          case 'spoiler':
            return '[spoiler]';
          default:
            return inline(node.children);
        }
      })
      .join('');
  return parseMarkdown(raw)
    .map((block) => (block.type === 'codeblock' ? block.value : inline(block.children)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
};

/** Does the tree mention this account (a resolved mention)? */
export const mentionsAccount = (blocks: readonly BlockNode[], accountId: string): boolean => {
  const inline = (nodes: readonly InlineNode[]): boolean =>
    nodes.some((node) => (node.type === 'mention' ? node.accountId === accountId : 'children' in node ? inline(node.children) : false));
  return blocks.some((block) => block.type === 'paragraph' && inline(block.children));
};
