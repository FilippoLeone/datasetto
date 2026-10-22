import { computed, signal, type ReadonlySignal } from '@preact/signals';
import { audioSettings, type DataSaverVoice } from '@/state/settings';

/**
 * Is this device's link too small for full-quality voice? While it is, VoiceService caps
 * every voice sender at 24 kbps, asks peers for the same in its SDP, and the voice manager
 * tells the peers (`voice:link`) so they cap what they send here. In a 4-person call on
 * 3G that is about 147 kbps each way instead of about 460 kbps.
 *
 * "Auto" (the default) counts the link as constrained when any of these holds:
 * - the connection is mobile data (`navigator.connection.type === 'cellular'`, Android);
 * - its effective type is `slow-2g`, `2g` or `3g`;
 * - the browser's data saver is on (`saveData`);
 * - the measured downlink is under 2 Mbps;
 * - in a call, the outgoing bandwidth estimate stays below what the call's voice needs
 *   for 5 s (see `reportCallBandwidth`).
 * "On" and "Off" override the detection.
 */
export type LinkReason = 'cellular' | 'slow-network' | 'save-data' | 'low-downlink' | 'call-bandwidth';

/** The subset of the Network Information API this module reads. */
export interface ConnectionInfo {
  readonly type?: string;
  readonly effectiveType?: string;
  readonly saveData?: boolean;
  /** Mbps, as estimated by the browser. */
  readonly downlink?: number;
  addEventListener?: (type: 'change', listener: () => void) => void;
}

/** One stats round over the call's connections, in bits per second. */
export interface CallBandwidthSample {
  /** Sum of `availableOutgoingBitrate` over the connections that report it. */
  estimate: number;
  /** What their voice senders need at the current caps, packet overhead included. */
  need: number;
}

const SLOW_TYPES = new Set(['slow-2g', '2g', '3g']);
const LOW_DOWNLINK_MBPS = 2;
/** How long the estimate must stay below the need before the call counts as constrained. */
export const CALL_BANDWIDTH_HOLD_MS = 5000;
/**
 * While capped, the estimate cannot show that the link got better (the browser's
 * estimate follows what is sent), so the cap is lifted for a re-test after this long,
 * doubling up to the maximum each time the re-test trips again within the calm period.
 */
export const CALL_BANDWIDTH_RETEST_MS = 60_000;
export const CALL_BANDWIDTH_RETEST_MAX_MS = 8 * 60_000;
const CALL_BANDWIDTH_CALM_MS = 30_000;

const readNetwork = (connection: ConnectionInfo | null | undefined): LinkReason | null => {
  if (!connection) return null;
  if (connection.type === 'cellular') return 'cellular';
  if (connection.effectiveType && SLOW_TYPES.has(connection.effectiveType)) return 'slow-network';
  if (connection.saveData === true) return 'save-data';
  if (typeof connection.downlink === 'number' && connection.downlink > 0 && connection.downlink < LOW_DOWNLINK_MBPS) return 'low-downlink';
  return null;
};

export interface LinkConstraint {
  /** After the Auto / On / Off preference is applied. */
  readonly constrained: ReadonlySignal<boolean>;
  /** Why Auto would cap voice right now (null: it would not), whatever the preference. */
  readonly autoReason: ReadonlySignal<LinkReason | null>;
  /** Feed one stats round while in a call; `null` when the call ends or has no connections. */
  reportCallBandwidth(sample: CallBandwidthSample | null, now?: number): void;
}

export const createLinkConstraint = (options: {
  connection: ConnectionInfo | null | undefined;
  preference: ReadonlySignal<DataSaverVoice>;
}): LinkConstraint => {
  const { connection, preference } = options;
  const network = signal<LinkReason | null>(readNetwork(connection));
  connection?.addEventListener?.('change', () => {
    network.value = readNetwork(connection);
  });

  const callLow = signal(false);
  let lowSince: number | null = null;
  let cappedAt = 0;
  let retestMs = CALL_BANDWIDTH_RETEST_MS;
  let retestedAt: number | null = null;

  const autoReason = computed<LinkReason | null>(() => network.value ?? (callLow.value ? 'call-bandwidth' : null));
  const constrained = computed(() => {
    const choice = preference.value;
    if (choice === 'on') return true;
    if (choice === 'off') return false;
    return autoReason.value !== null;
  });

  const reportCallBandwidth = (sample: CallBandwidthSample | null, now = Date.now()): void => {
    if (!sample) {
      lowSince = null;
      retestedAt = null;
      retestMs = CALL_BANDWIDTH_RETEST_MS;
      callLow.value = false;
      return;
    }
    // Only an uncapped call says anything about the link: while the preference or the
    // network already caps voice, the estimate just follows the cap.
    if (preference.value !== 'auto' || network.value !== null) {
      lowSince = null;
      callLow.value = false;
      return;
    }
    if (callLow.value) {
      if (now - cappedAt < retestMs) return;
      callLow.value = false;
      retestedAt = now;
      lowSince = null;
      return;
    }
    if (sample.need > 0 && sample.estimate < sample.need) {
      lowSince ??= now;
      if (now - lowSince < CALL_BANDWIDTH_HOLD_MS) return;
      const trippedRightAfterRetest = retestedAt !== null && now - retestedAt < CALL_BANDWIDTH_CALM_MS;
      retestMs = trippedRightAfterRetest ? Math.min(retestMs * 2, CALL_BANDWIDTH_RETEST_MAX_MS) : CALL_BANDWIDTH_RETEST_MS;
      retestedAt = null;
      lowSince = null;
      cappedAt = now;
      callLow.value = true;
      return;
    }
    lowSince = null;
    if (retestedAt !== null && now - retestedAt >= CALL_BANDWIDTH_CALM_MS) retestedAt = null;
  };

  return { constrained, autoReason, reportCallBandwidth };
};

const sharedConnection = (): ConnectionInfo | null =>
  typeof navigator === 'undefined' ? null : ((navigator as Navigator & { connection?: ConnectionInfo }).connection ?? null);

const shared = createLinkConstraint({
  connection: sharedConnection(),
  preference: computed(() => audioSettings.value.dataSaverVoice),
});

/** True while voice should be capped at 24 kbps per stream (after the Auto / On / Off preference). */
export const linkConstrained: ReadonlySignal<boolean> = shared.constrained;
/** Why Auto caps voice right now, or null; the audio settings show it. */
export const linkAutoReason: ReadonlySignal<LinkReason | null> = shared.autoReason;
/** The voice manager feeds every stats round of a call here, and `null` when the call ends. */
export const reportCallBandwidth = shared.reportCallBandwidth;
