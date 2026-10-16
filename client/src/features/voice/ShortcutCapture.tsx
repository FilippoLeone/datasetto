import { useEffect, useRef, useState } from 'preact/hooks';
import { AlertTriangle, Check, Keyboard, X } from 'lucide-preact';
import { Button } from '@/components';
import { cn } from '@/lib/cn';
import { formatShortcut, isBareTypingKey, isModifierCode, parseShortcut, serializeShortcut, shortcutFromEvent, toElectronAccelerator, type Shortcut } from '@/lib/shortcut';
import { isDesktopApp } from '@/services/native/desktop';
import { checkGlobalShortcut, globalPttStatus, globalPttSuspended, supportsGlobalPushToTalk } from './desktopVoice';

interface ShortcutCaptureProps {
  /** Stored shortcut (`Ctrl+Shift+KeyV`), empty for none. */
  value: string;
  onChange: (value: string) => void;
}

type Hint = { tone: 'ok' | 'warn' | 'muted'; text: string };

/** The key combination as chips: `Ctrl` `Shift` `V`. */
const Keys = ({ shortcut }: { shortcut: Shortcut }) => (
  <span className="inline-flex flex-wrap items-center gap-1">
    {formatShortcut(shortcut)
      .split(' + ')
      .map((part, index) => (
        <kbd key={index} className="rounded-sm border-b border-black/50 bg-active px-1.5 py-0.5 font-sans text-xs text-text-bright">
          {part}
        </kbd>
      ))}
  </span>
);

/**
 * Records a key or key combination for push to talk. Pressing a modifier on its own
 * (right Ctrl, say) records that modifier; Escape cancels. In the desktop app it also
 * tells whether the combination works while other windows have focus.
 */
export const ShortcutCapture = ({ value, onChange }: ShortcutCaptureProps) => {
  const [capturing, setCapturing] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const shortcut = parseShortcut(value);
  const desktop = isDesktopApp();
  const globalSupport = supportsGlobalPushToTalk();
  const accelerator = toElectronAccelerator(shortcut);
  // The modifier that went down last; released without another key it becomes the shortcut.
  const pendingModifier = useRef<string | null>(null);

  useEffect(() => {
    if (!capturing) return;
    pendingModifier.current = null;
    // Drop the system-wide registration so the key we are about to record reaches this window.
    globalPttSuspended.value = true;
    const finish = (next: Shortcut | null) => {
      setCapturing(false);
      if (next) onChange(serializeShortcut(next));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'Escape') {
        finish(null);
        return;
      }
      if (isModifierCode(event.code)) {
        pendingModifier.current = event.code;
        return;
      }
      if (!event.code) return;
      finish(shortcutFromEvent(event));
    };
    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (pendingModifier.current && event.code === pendingModifier.current) finish(shortcutFromEvent(event));
    };
    const onBlur = () => finish(null);
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('blur', onBlur);
      globalPttSuspended.value = false;
    };
  }, [capturing, onChange]);

  // Ask the shell whether the combination is free (the system or another app may own it).
  useEffect(() => {
    if (!globalSupport || !accelerator) {
      setAvailable(null);
      return;
    }
    let cancelled = false;
    void checkGlobalShortcut(accelerator).then((ok) => {
      if (!cancelled) setAvailable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [accelerator, globalSupport]);

  const hints: Hint[] = [];
  if (shortcut) {
    const live = globalPttStatus.value;
    if (globalSupport) {
      if (!accelerator) {
        hints.push({ tone: 'warn', text: 'A modifier on its own works only while the Datasetto window is focused. Add a letter, number or function key to use it in the background.' });
      } else if (available === false || live === 'taken') {
        hints.push({ tone: 'warn', text: 'Already used by the system or another app. It works while Datasetto is focused, not in the background. Pick another combination for gaming.' });
      } else if (live === 'invalid') {
        hints.push({ tone: 'warn', text: 'The desktop app could not register this key. It works while Datasetto is focused.' });
      } else {
        hints.push({ tone: 'ok', text: 'Works in the background in the desktop app, also while a game has focus.' });
      }
      if (accelerator && isBareTypingKey(shortcut)) {
        hints.push({ tone: 'warn', text: 'While you are in voice, other apps will not receive this key. A function key, a numpad key or a combination with Ctrl or Alt avoids that.' });
      }
    } else if (desktop) {
      hints.push({ tone: 'muted', text: 'This desktop app is older: the key works while its window is focused. Update it to use the key in the background.' });
    } else {
      hints.push({ tone: 'muted', text: 'Works while this tab is focused. The desktop app can listen in the background.' });
    }
  }

  return (
    <div className="py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-text-bright">
          <span className="mr-2">Key</span>
          {capturing ? (
            <span className="text-text-muted">Press a key or combination… Esc cancels</span>
          ) : shortcut ? (
            <Keys shortcut={shortcut} />
          ) : (
            <span className="text-text-muted">not set</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant={capturing ? 'primary' : 'secondary'} onClick={() => setCapturing((current) => !current)} aria-pressed={capturing}>
            <Keyboard size={14} /> {capturing ? 'Listening…' : shortcut ? 'Change' : 'Set key'}
          </Button>
          {shortcut && !capturing && (
            <Button size="sm" variant="ghost" aria-label="Clear key" onClick={() => onChange('')}>
              <X size={14} />
            </Button>
          )}
        </span>
      </div>
      {hints.map((hint) => (
        <p key={hint.text} className={cn('mt-1.5 flex items-start gap-1.5 text-xs', hint.tone === 'ok' && 'text-success', hint.tone === 'warn' && 'text-warning', hint.tone === 'muted' && 'text-text-muted')}>
          {hint.tone === 'ok' ? <Check size={14} className="mt-0.5 shrink-0" /> : hint.tone === 'warn' ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> : null}
          <span>{hint.text}</span>
        </p>
      ))}
    </div>
  );
};
