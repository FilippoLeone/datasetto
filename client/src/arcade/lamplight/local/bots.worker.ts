/**
 * Offline bot thinking off the main thread (lamplight.md §11). Started on the first bot decision and
 * terminated when the table hides or closes; it runs each decision unsliced at the Worker's trial caps.
 */
import { createThinker } from '@arcade/core/lamplight/bots';
import type { ThinkRequest } from './thinkerMain';

self.onmessage = (event: MessageEvent<ThinkRequest>) => {
  const r = event.data;
  const th = createThinker(r.view, r.seat, r.level, r.seed, { maxTrials: r.maxTrials });
  th.step(r.maxTrials);
  (self as unknown as Worker).postMessage({ id: r.id, action: th.decide() });
};
