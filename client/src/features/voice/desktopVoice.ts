/**
 * Voice features that only the Electron shell provides: the system-wide push-to-talk key
 * and the always-on-top voice overlay. Everything here feature-detects the bridge, so a
 * browser, a phone or an older desktop shell without these IPC channels simply skips it.
 */
import { effect, signal } from '@preact/signals';
import { generateIdenticonDataUri } from '@/lib/avatar';
import { resolveAvatarUrl } from '@/lib/avatarUrl';
import { parseShortcut, toElectronAccelerator } from '@/lib/shortcut';
import { usersById } from '@/state/presence';
import { account, socketId } from '@/state/session';
import { audioSettings } from '@/state/settings';
import { channelsById } from '@/state/channels';
import { localDeafened, localMuted, localSpeaking, peerList, pttPressed, voiceChannelId, voiceStatus } from '@/state/voice';
import { expireHold, initialHoldState, pressHold, releaseHold, type HoldState } from './pushToTalkHold';
import { buildOverlayState, sameOverlayState, type VoiceOverlayState } from './voiceOverlayState';
import { voiceManager } from './voiceManager';

export type GlobalPttSupport = 'unsupported' | 'no-accelerator' | 'idle' | 'registered' | 'taken' | 'invalid';

/**
 * Where the system-wide push-to-talk key stands:
 *   unsupported    not the desktop app, or a shell without the IPC channel
 *   no-accelerator the shortcut cannot be registered system-wide (a modifier alone)
 *   idle           supported, nothing registered right now (not in voice, or push to talk off)
 *   registered     the key works while other windows have focus
 *   taken          the system or another app owns the combination; it works only in the window
 *   invalid        Electron rejected the accelerator
 */
export const globalPttStatus = signal<GlobalPttSupport>('unsupported');

/** The settings dialog pauses the registration while it records a new key. */
export const globalPttSuspended = signal(false);

const bridge = () => (typeof window !== 'undefined' ? window.desktopAPI : undefined);

export const supportsGlobalPushToTalk = (): boolean => typeof bridge()?.setPushToTalkShortcut === 'function';
export const supportsVoiceOverlay = (): boolean => typeof bridge()?.updateVoiceOverlay === 'function' && typeof bridge()?.configureVoiceOverlay === 'function';

/** Could this accelerator be registered right now? Unsupported shells say yes to keep the UI quiet. */
export const checkGlobalShortcut = async (accelerator: string): Promise<boolean> => {
  const api = bridge();
  if (!api?.checkPushToTalkShortcut) return true;
  try {
    return (await api.checkPushToTalkShortcut(accelerator)).available;
  } catch {
    return true;
  }
};

/** Absolute avatar URL (or generated identicon) that another window can load. */
const overlayAvatar = (seed: string, name: string, url: string | null | undefined): string => {
  const resolved = resolveAvatarUrl(url);
  if (resolved) {
    if (/^(https?:|data:|blob:)/.test(resolved)) return resolved;
    try {
      return new URL(resolved, window.location.href).href;
    } catch {
      /* fall through to the identicon */
    }
  }
  return generateIdenticonDataUri(seed || name);
};

let installed = false;

/** Wire the signals to the desktop bridge. Idempotent, no-op outside the desktop app. */
export const installDesktopVoice = (): void => {
  if (installed) return;
  installed = true;
  installGlobalPushToTalk();
  installVoiceOverlay();
};

const installGlobalPushToTalk = (): void => {
  const api = bridge();
  if (!api?.setPushToTalkShortcut || !api.onPushToTalkPressed) return;
  const setShortcut = api.setPushToTalkShortcut;
  globalPttStatus.value = 'idle';

  // Hold tracking: presses (and the OS key repeats) arrive, releases are inferred.
  let hold: HoldState = initialHoldState;
  let releaseTimer: number | null = null;
  const clearReleaseTimer = () => {
    if (releaseTimer !== null) window.clearTimeout(releaseTimer);
    releaseTimer = null;
  };
  const release = () => {
    hold = releaseHold();
    clearReleaseTimer();
    voiceManager.setPushToTalkHeld('global', false);
  };
  const checkRelease = () => {
    releaseTimer = null;
    hold = expireHold(hold, Date.now());
    if (!hold.held) {
      voiceManager.setPushToTalkHeld('global', false);
      return;
    }
    releaseTimer = window.setTimeout(checkRelease, Math.max(10, (hold.releaseAt ?? 0) - Date.now()));
  };
  api.onPushToTalkPressed(() => {
    if ((voiceStatus.value !== 'connected' && voiceStatus.value !== 'reconnecting') || !audioSettings.value.pttEnable) return;
    hold = pressHold(hold, Date.now());
    voiceManager.setPushToTalkHeld('global', true);
    clearReleaseTimer();
    releaseTimer = window.setTimeout(checkRelease, Math.max(10, (hold.releaseAt ?? 0) - Date.now()));
  });

  // Register while in voice with push to talk on, drop it otherwise.
  let current: string | null = null;
  let generation = 0;
  effect(() => {
    const settings = audioSettings.value;
    // A call on hold while the socket reconnects is still a call: the key keeps working.
    const inVoice = voiceStatus.value === 'connected' || voiceStatus.value === 'reconnecting';
    const shortcut = settings.pttEnable ? parseShortcut(settings.pttKey) : null;
    const accelerator = toElectronAccelerator(shortcut);
    const wanted = inVoice && !globalPttSuspended.value && accelerator ? accelerator : null;
    if (shortcut && !accelerator) globalPttStatus.value = 'no-accelerator';
    else if (!wanted) globalPttStatus.value = 'idle';
    if (wanted === current) return;
    current = wanted;
    if (!wanted) release();
    const myGeneration = ++generation;
    setShortcut(wanted)
      .then((status) => {
        if (myGeneration !== generation || !wanted) return;
        globalPttStatus.value = status.registered ? 'registered' : status.error === 'invalid' ? 'invalid' : 'taken';
      })
      .catch(() => {
        if (myGeneration === generation && wanted) globalPttStatus.value = 'invalid';
      });
  });
};

const installVoiceOverlay = (): void => {
  const api = bridge();
  if (!api?.updateVoiceOverlay || !api.configureVoiceOverlay) return;
  const update = api.updateVoiceOverlay;
  const configure = api.configureVoiceOverlay;

  let lastConfig = '';
  effect(() => {
    const { overlayEnabled, overlayCorner } = audioSettings.value;
    const key = overlayEnabled + ':' + overlayCorner;
    if (key === lastConfig) return;
    lastConfig = key;
    void configure({ enabled: overlayEnabled, corner: overlayCorner }).catch(() => undefined);
  });

  let last: VoiceOverlayState | null = null;
  effect(() => {
    const me = account.value;
    const channel = voiceChannelId.value ? channelsById.value.get(voiceChannelId.value) : null;
    const users = usersById.value;
    const next = buildOverlayState({
      // The overlay stays up while the socket reconnects: the call itself never stopped.
      status: voiceStatus.value === 'reconnecting' ? 'connected' : voiceStatus.value,
      channelName: channel?.name,
      me: me ? { id: socketId.value ?? 'me', name: me.displayName, avatarUrl: overlayAvatar(me.id, me.displayName, me.avatarUrl) } : null,
      peers: peerList.value,
      avatarFor: (peerId) => {
        const user = users.get(peerId);
        return overlayAvatar(user?.accountId ?? peerId, user?.displayName ?? peerId, user?.avatarUrl);
      },
      localMuted: localMuted.value,
      localDeafened: localDeafened.value,
      localSpeaking: localSpeaking.value,
      pttEnable: audioSettings.value.pttEnable,
      pttPressed: pttPressed.value,
    });
    if (sameOverlayState(last, next)) return;
    last = next;
    try {
      update(next);
    } catch {
      /* the bridge is gone (window closing) */
    }
  });
};
