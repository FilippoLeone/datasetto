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

/**
 * Does the text @-mention one of these names? A fallback for messages without the
 * server's resolved mentions (lib/markdown.ts does the rendering).
 */
export const containsMention = (text: string, names: readonly string[]): boolean => {
  const lower = text.toLowerCase();
  return names.some((name) => name && lower.includes('@' + name.toLowerCase()));
};

export const EMOJIS = [
  '😀', '😂', '🤣', '😊', '😍', '🥰', '😎', '🤔', '😅', '😭', '😡', '🥳', '🤯', '😴', '🙃', '😬',
  '👍', '👎', '👏', '🙌', '🙏', '🤝', '💪', '👀', '🔥', '✨', '💯', '🎉', '❤️', '💜', '💔', '⭐',
  '🎮', '🎧', '🎤', '📺', '🖥️', '🕹️', '🏆', '🎯', '💀', '👻', '🤖', '🐸', '🍕', '☕', '🍻', '🚀',
];
