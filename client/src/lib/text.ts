/** Only http(s) links are clickable; everything else is rendered as text. */
export const sanitizeUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

export type MessageToken =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; href: string }
  | { type: 'mention'; value: string }
  | { type: 'break' };

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const MENTION_PATTERN = /@[A-Za-z0-9_.-]+/g;

const tokenizeMentions = (text: string, out: MessageToken[]): void => {
  let last = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ type: 'text', value: text.slice(last, index) });
    out.push({ type: 'mention', value: match[0] });
    last = index + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
};

/** Split a message into renderable tokens: text, links, @mentions and line breaks. */
export const tokenizeMessage = (raw: string): MessageToken[] => {
  const tokens: MessageToken[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) tokens.push({ type: 'break' });
    let last = 0;
    for (const match of line.matchAll(URL_PATTERN)) {
      const index = match.index ?? 0;
      if (index > last) tokenizeMentions(line.slice(last, index), tokens);
      const href = sanitizeUrl(match[0]);
      if (href) tokens.push({ type: 'link', value: match[0], href });
      else tokens.push({ type: 'text', value: match[0] });
      last = index + match[0].length;
    }
    if (last < line.length) tokenizeMentions(line.slice(last), tokens);
  });
  return tokens;
};

export const containsMention = (text: string, names: readonly string[]): boolean => {
  const lower = text.toLowerCase();
  return names.some((name) => name && lower.includes('@' + name.toLowerCase()));
};

export const EMOJIS = [
  '😀', '😂', '🤣', '😊', '😍', '🥰', '😎', '🤔', '😅', '😭', '😡', '🥳', '🤯', '😴', '🙃', '😬',
  '👍', '👎', '👏', '🙌', '🙏', '🤝', '💪', '👀', '🔥', '✨', '💯', '🎉', '❤️', '💜', '💔', '⭐',
  '🎮', '🎧', '🎤', '📺', '🖥️', '🕹️', '🏆', '🎯', '💀', '👻', '🤖', '🐸', '🍕', '☕', '🍻', '🚀',
];
