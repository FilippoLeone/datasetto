/**
 * Where offline bots think (lamplight.md §11, §13): a module Worker started on demand, or, when the
 * Worker cannot start or does not answer within 1 s (a desktop `file://` edge case, say), the main
 * thread in slices of ≤ 200 trials yielded through `setTimeout(0)` at the server's caps.
 */
import { BOT_TRIALS, createThinker, SLICE_TRIALS } from '@arcade/core/lamplight/bots';
import type { Action, BotLevel, TableState } from '@arcade/core/lamplight/engine';

export interface ThinkRequest {
  id: number;
  view: TableState;
  seat: number;
  level: BotLevel;
  seed: number;
  maxTrials: number;
}

export interface ThinkService {
  think(r: Omit<ThinkRequest, 'id' | 'maxTrials'>): Promise<Action>;
  /** The table hid: stop the Worker (it is started again on the next decision). */
  idle(): void;
  dispose(): void;
  /** 'worker' once a Worker answered, 'main' after falling back. */
  readonly mode: 'pending' | 'worker' | 'main';
}

const WORKER_TIMEOUT_MS = 1000;

export const createWorker = (): Worker | null => {
  try {
    return new Worker(new URL('./bots.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
};

export const createThinkService = (factory: () => Worker | null = createWorker): ThinkService => {
  let worker: Worker | null = null;
  let mode: ThinkService['mode'] = 'pending';
  let nextId = 1;
  let disposed = false;
  /** Bumped by idle(): main-thread slices of an older epoch stop. */
  let epoch = 0;
  const waiting = new Map<number, { resolve(a: Action): void; req: ThinkRequest; timer: ReturnType<typeof setTimeout> | null }>();
  const slices = new Set<ReturnType<typeof setTimeout>>();

  /** Main-thread fallback: sliced, at the server's trial caps. */
  const onMain = (req: ThinkRequest): Promise<Action> =>
    new Promise((resolve) => {
      const th = createThinker(req.view, req.seat, req.level, req.seed, { maxTrials: BOT_TRIALS.server[req.level] });
      const mine = epoch;
      const run = () => {
        if (disposed || mine !== epoch) return;
        if (th.step(SLICE_TRIALS)) resolve(th.decide());
        else {
          const t = setTimeout(() => {
            slices.delete(t);
            run();
          }, 0);
          slices.add(t);
        }
      };
      run();
    });

  const fallBack = (): void => {
    mode = 'main';
    worker?.terminate();
    worker = null;
    for (const [id, w] of Array.from(waiting)) {
      waiting.delete(id);
      if (w.timer) clearTimeout(w.timer);
      void onMain(w.req).then(w.resolve);
    }
  };

  const ensureWorker = (): Worker | null => {
    if (worker || mode === 'main' || disposed) return worker;
    worker = factory();
    if (!worker) {
      mode = 'main';
      return null;
    }
    worker.onmessage = (e: MessageEvent<{ id: number; action: Action }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      mode = 'worker';
      waiting.delete(e.data.id);
      if (w.timer) clearTimeout(w.timer);
      w.resolve(e.data.action);
    };
    worker.onerror = () => fallBack();
    return worker;
  };

  const idle = (): void => {
    epoch++;
    // Pending decisions are dropped: the table asks again when it resumes.
    for (const w of waiting.values()) if (w.timer) clearTimeout(w.timer);
    waiting.clear();
    for (const t of slices) clearTimeout(t);
    slices.clear();
    worker?.terminate();
    worker = null;
  };

  return {
    think(r) {
      const req: ThinkRequest = { ...r, id: nextId++, maxTrials: BOT_TRIALS.worker[r.level] };
      const w = ensureWorker();
      if (!w) return onMain(req);
      return new Promise((resolve) => {
        // Until the Worker has answered once, a silent one counts as broken.
        const timer =
          mode === 'pending'
            ? setTimeout(() => {
                if (waiting.has(req.id)) fallBack();
              }, WORKER_TIMEOUT_MS)
            : null;
        waiting.set(req.id, { resolve, req, timer });
        try {
          w.postMessage(req);
        } catch {
          fallBack();
        }
      });
    },
    idle,
    dispose() {
      disposed = true;
      idle();
    },
    get mode() {
      return mode;
    },
  };
};
