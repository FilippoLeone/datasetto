import { describe, expect, it } from 'vitest';
import { INSTALL_HINT_SNOOZE_MS, installHintFor, type InstallContext } from './installPrompt';

const android: InstallContext = { standalone: false, nativeApp: false, touch: true, platform: 'android', canPrompt: true, dismissedAt: null, now: 1_000_000 };
const ios: InstallContext = { ...android, platform: 'ios', canPrompt: false };

describe('installHintFor', () => {
  it('offers the browser prompt where one is waiting', () => {
    expect(installHintFor(android)).toBe('prompt');
    expect(installHintFor({ ...android, canPrompt: false })).toBe('none');
  });

  it('explains the Share sheet steps on iOS, where there is no prompt', () => {
    expect(installHintFor(ios)).toBe('ios-steps');
    // An iOS browser that did fire a prompt (none does today) would get the prompt.
    expect(installHintFor({ ...ios, canPrompt: true })).toBe('prompt');
  });

  it('stays quiet once installed, inside the shells and on desktop', () => {
    expect(installHintFor({ ...android, standalone: true })).toBe('none');
    expect(installHintFor({ ...android, nativeApp: true })).toBe('none');
    expect(installHintFor({ ...android, touch: false })).toBe('none');
    expect(installHintFor({ ...ios, standalone: true })).toBe('none');
  });

  it('respects "Not now" for two weeks', () => {
    const dismissed = { ...android, dismissedAt: android.now - INSTALL_HINT_SNOOZE_MS + 1 };
    expect(installHintFor(dismissed)).toBe('none');
    expect(installHintFor({ ...dismissed, now: dismissed.dismissedAt! + INSTALL_HINT_SNOOZE_MS })).toBe('prompt');
    expect(installHintFor({ ...ios, dismissedAt: ios.now - 1000 })).toBe('none');
  });
});
