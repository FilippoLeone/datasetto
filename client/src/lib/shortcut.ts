/**
 * Keyboard shortcuts for push-to-talk: a key (`KeyboardEvent.code`) plus modifiers.
 *
 * Stored as a string such as `Ctrl+Shift+KeyV` or `F13` (the old client saved the bare
 * `KeyboardEvent.code`, which still parses as a shortcut without modifiers). The same
 * shortcut is shown to people as `Ctrl + Shift + V` and handed to the Electron shell as
 * an accelerator (`Control+Shift+V`) so it can be registered system-wide.
 */

export interface Shortcut {
  /** `KeyboardEvent.code` of the main key, or of the modifier itself for a modifier-only shortcut. */
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export type ModifierName = 'ctrl' | 'shift' | 'alt' | 'meta';

/** Modifier keys by their `KeyboardEvent.code`. */
const MODIFIER_CODES: Record<string, ModifierName> = {
  ControlLeft: 'ctrl',
  ControlRight: 'ctrl',
  ShiftLeft: 'shift',
  ShiftRight: 'shift',
  AltLeft: 'alt',
  AltRight: 'alt',
  MetaLeft: 'meta',
  MetaRight: 'meta',
  OSLeft: 'meta',
  OSRight: 'meta',
};

/** Tokens used in the stored string, in display order. */
const MODIFIER_TOKENS: Array<[ModifierName, string]> = [
  ['ctrl', 'Ctrl'],
  ['alt', 'Alt'],
  ['shift', 'Shift'],
  ['meta', 'Meta'],
];

/** Electron accelerator names for the keys that have no letter or digit of their own. */
const ELECTRON_KEYS: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  CapsLock: 'Capslock',
  NumLock: 'Numlock',
  ScrollLock: 'Scrolllock',
  PrintScreen: 'PrintScreen',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: '"',
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadDecimal: 'numdec',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  AudioVolumeUp: 'VolumeUp',
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeMute: 'VolumeMute',
  MediaPlayPause: 'MediaPlayPause',
  MediaStop: 'MediaStop',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
};

/** Readable names for keys whose code is not already readable. */
const KEY_LABELS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  Escape: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  CapsLock: 'Caps Lock',
  NumLock: 'Num Lock',
  ScrollLock: 'Scroll Lock',
  PrintScreen: 'Print Screen',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadDecimal: 'Num .',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  AudioVolumeUp: 'Volume Up',
  AudioVolumeDown: 'Volume Down',
  AudioVolumeMute: 'Volume Mute',
  MediaPlayPause: 'Play/Pause',
  MediaStop: 'Media Stop',
  MediaTrackNext: 'Next Track',
  MediaTrackPrevious: 'Previous Track',
  ContextMenu: 'Menu',
};

export const isModifierCode = (code: string): boolean => code in MODIFIER_CODES;

/** Which modifier a key is, or null for a normal key. */
export const modifierOf = (code: string): ModifierName | null => MODIFIER_CODES[code] ?? null;

export const isMacPlatform = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

/** `Ctrl+Shift+KeyV` or a bare code from the old client → Shortcut; empty or garbage → null. */
export const parseShortcut = (stored: string | null | undefined): Shortcut | null => {
  if (!stored) return null;
  const tokens = stored
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const shortcut: Shortcut = { code: '', ctrl: false, shift: false, alt: false, meta: false };
  for (const token of tokens) {
    const modifier = MODIFIER_TOKENS.find(([, name]) => name.toLowerCase() === token.toLowerCase());
    if (modifier) shortcut[modifier[0]] = true;
    else shortcut.code = token;
  }
  if (!shortcut.code) return null;
  // A modifier key as the main key carries no flags of its own family.
  const own = MODIFIER_CODES[shortcut.code];
  if (own) shortcut[own] = false;
  return shortcut;
};

/** Shortcut → the stored form (`Ctrl+Shift+KeyV`). */
export const serializeShortcut = (shortcut: Shortcut): string => {
  const parts = MODIFIER_TOKENS.filter(([name]) => shortcut[name] && MODIFIER_CODES[shortcut.code] !== name).map(([, token]) => token);
  return [...parts, shortcut.code].join('+');
};

/** Readable name of a single key: `KeyV` → `V`, `Digit1` → `1`, `ControlRight` → `Right Ctrl`. */
export const describeKey = (code: string, mac: boolean = isMacPlatform()): string => {
  const own = MODIFIER_CODES[code];
  if (own) {
    const side = code.endsWith('Right') ? 'Right ' : 'Left ';
    return side + describeModifier(own, mac);
  }
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad) return 'Num ' + numpad[1];
  if (/^F\d{1,2}$/.test(code)) return code;
  // Anything else: split the camel case (`BrowserBack` → `Browser Back`).
  return code.replace(/([a-z])([A-Z])/g, '$1 $2');
};

export const describeModifier = (name: ModifierName, mac: boolean = isMacPlatform()): string => {
  switch (name) {
    case 'ctrl':
      return 'Ctrl';
    case 'alt':
      return mac ? 'Option' : 'Alt';
    case 'shift':
      return 'Shift';
    case 'meta':
      return mac ? 'Cmd' : 'Win';
  }
};

/** `Ctrl + Shift + V`, `F13`, `Right Ctrl`. */
export const formatShortcut = (shortcut: Shortcut | null, mac: boolean = isMacPlatform()): string => {
  if (!shortcut) return '';
  const own = MODIFIER_CODES[shortcut.code];
  const parts = MODIFIER_TOKENS.filter(([name]) => shortcut[name] && own !== name).map(([name]) => describeModifier(name, mac));
  return [...parts, describeKey(shortcut.code, mac)].join(' + ');
};

/** The shortcut a key press stands for: the pressed key plus the modifiers held with it. */
export const shortcutFromEvent = (event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): Shortcut => {
  const own = MODIFIER_CODES[event.code];
  return {
    code: event.code,
    ctrl: own !== 'ctrl' && event.ctrlKey,
    shift: own !== 'shift' && event.shiftKey,
    alt: own !== 'alt' && event.altKey,
    meta: own !== 'meta' && event.metaKey,
  };
};

/**
 * Does a key event belong to the shortcut? A press must carry exactly the shortcut's
 * modifiers (so a plain `V` is not triggered by Ctrl+V); a release only has to be the
 * same key, because people let go of the modifiers in any order.
 */
export const shortcutMatchesEvent = (
  shortcut: Shortcut,
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  phase: 'down' | 'up',
): boolean => {
  if (event.code !== shortcut.code) return false;
  if (phase === 'up') return true;
  const own = MODIFIER_CODES[shortcut.code];
  return (
    (own === 'ctrl' || event.ctrlKey === shortcut.ctrl) &&
    (own === 'shift' || event.shiftKey === shortcut.shift) &&
    (own === 'alt' || event.altKey === shortcut.alt) &&
    (own === 'meta' || event.metaKey === shortcut.meta)
  );
};

/** The Electron accelerator name of a key, or null when Electron cannot register it. */
export const electronKeyFor = (code: string): string | null => {
  if (MODIFIER_CODES[code]) return null;
  if (ELECTRON_KEYS[code]) return ELECTRON_KEYS[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad) return 'num' + numpad[1];
  const fn = /^F(\d{1,2})$/.exec(code);
  if (fn && Number(fn[1]) >= 1 && Number(fn[1]) <= 24) return code;
  return null;
};

/**
 * `Control+Shift+V`: the accelerator the desktop shell registers with the operating
 * system. Null for a modifier-only shortcut and for keys Electron has no name for;
 * those work only while the Datasetto window is focused.
 */
export const toElectronAccelerator = (shortcut: Shortcut | null): string | null => {
  if (!shortcut) return null;
  const key = electronKeyFor(shortcut.code);
  if (!key) return null;
  const parts: string[] = [];
  if (shortcut.ctrl) parts.push('Control');
  if (shortcut.alt) parts.push('Alt');
  if (shortcut.shift) parts.push('Shift');
  if (shortcut.meta) parts.push('Super');
  parts.push(key);
  return parts.join('+');
};

/**
 * A letter, digit, punctuation or space without modifiers: fine in the window, but
 * registered system-wide it is swallowed everywhere while you are in voice, so other
 * apps cannot type it.
 */
export const isBareTypingKey = (shortcut: Shortcut | null): boolean => {
  if (!shortcut || shortcut.ctrl || shortcut.alt || shortcut.meta) return false;
  const { code } = shortcut;
  return /^(Key[A-Z]|Digit\d|Space|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|Enter|Backspace|Tab)$/.test(code);
};
