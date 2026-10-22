/**
 * "Your turn" while the game is not in front of you (lamplight.md §14.6): a prefix on the tab title
 * and, in the desktop shell, a flashing taskbar entry (or a dock bounce on macOS) until the window
 * gets focus. The shell bridge also sets `arcadeSession.attention` for the in-app badge.
 */
import { requestDesktopAttention } from './p0';

export const ATTENTION_PREFIX = '(•) ';

export interface AttentionHelper {
  set(on: boolean): void;
  dispose(): void;
}

export const createAttention = (): AttentionHelper => {
  let on = false;

  const set = (next: boolean): void => {
    if (next === on) return;
    on = next;
    if (typeof document !== 'undefined') {
      const title = document.title;
      if (next && !title.startsWith(ATTENTION_PREFIX)) document.title = ATTENTION_PREFIX + title;
      if (!next && title.startsWith(ATTENTION_PREFIX)) document.title = title.slice(ATTENTION_PREFIX.length);
    }
    requestDesktopAttention(next);
  };

  return { set, dispose: () => set(false) };
};
