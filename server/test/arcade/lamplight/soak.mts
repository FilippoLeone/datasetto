/**
 * Lamplight soak (lamplight.md §18.5), on demand only, never in CI: bot-only 6-max hands with no think
 * time and a quarter of the server's trials, on 4 worker threads, with a hard stop at 60 s. It passes
 * when nothing throws, chips are conserved on every hand, and Sharp (seat 0) beats five Greenhorns at
 * 95 % confidence; it stops as soon as that bound is crossed (or up to 5,000 hands).
 *
 *   cd server && npx tsx test/arcade/lamplight/soak.mts
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const MAX_HANDS = 5000;
const WALL_MS = 60_000;
const THREADS = 4;
const BATCH = 25;
const MIN_HANDS = 300;

interface Batch {
  hands: number;
  /** Sharp's net per hand in big blinds. */
  nets: number[];
  conserved: boolean;
  error: string | null;
}

if (!isMainThread) {
  const { act, advance, createTable, pendingDelay, seat, startHand, tableChips } = await import('../../../src/arcade/core/lamplight/engine.ts');
  const { viewFor } = await import('../../../src/arcade/core/lamplight/views.ts');
  const { BOT_TRIALS, createThinker } = await import('../../../src/arcade/core/lamplight/bots.ts');
  const { newDeck, shuffle } = await import('../../../src/arcade/core/lamplight/cards.ts');
  const { cashLevel, tableConfig } = await import('../../../src/arcade/core/lamplight/schedule.ts');
  const { randInt, seedXoshiro, xoshiro128ss } = await import('../../../src/arcade/core/rng.ts');
  const st = seedXoshiro(workerData.seed as number);
  const u32 = () => xoshiro128ss(st);
  const rand = (n: number) => randInt(u32, n);
  const levels = ['sharp', 'greenhorn', 'greenhorn', 'greenhorn', 'greenhorn', 'greenhorn'] as const;
  const STACK = 1000;
  const state = createTable('soak' + workerData.seed, tableConfig({ format: 'open', tier: 'pebble', seats: 6, bots: null }), cashLevel('pebble'));
  for (let n = 0; n < 6; n++) {
    seat(state, n, { accountId: null, botId: 'b' + n, avatarSeed: n }, STACK);
    state.seats[n].status = 'active';
  }
  const run = (): Batch => {
    const out: Batch = { hands: 0, nets: [], conserved: true, error: null };
    try {
      for (let h = 0; h < BATCH; h++) {
        // Every seat tops back up to 100 big blinds, so hands are independent.
        for (const s of state.seats) {
          s.stack = STACK;
          if (s.status === 'busted') s.status = 'active';
        }
        const before = tableChips(state);
        const r = startHand(state, shuffle(newDeck(), rand), 0, rand(6));
        if (!r.ok) throw new Error('hand did not start');
        for (let g = 0; g < 400 && state.hand && state.hand.street !== 'done'; g++) {
          if (pendingDelay(state, 0) !== null) {
            advance(state, 0);
            continue;
          }
          const n = state.hand.toAct;
          const level = levels[n];
          const th = createThinker(viewFor(state, n), n, level, u32() || 1, { maxTrials: Math.ceil(BOT_TRIALS.server[level] / 4) });
          th.step(1_000_000);
          const res = act(state, n, th.decide(), 0);
          if (!res.ok) throw new Error('bot action refused: ' + res.code);
          if (tableChips(state) !== before) out.conserved = false;
        }
        if (state.hand?.street !== 'done') throw new Error('hand did not end');
        if (tableChips(state) !== before) out.conserved = false;
        out.nets.push((state.seats[0].stack - STACK) / 10);
        out.hands++;
      }
    } catch (e) {
      out.error = e instanceof Error ? e.stack ?? e.message : String(e);
    }
    return out;
  };
  parentPort?.on('message', (m: string) => {
    if (m === 'stop') process.exit(0);
    parentPort?.postMessage(run());
  });
  parentPort?.postMessage(run());
} else {
  const started = Date.now();
  let hands = 0;
  let sum = 0;
  let sumSq = 0;
  let verdict: 'pass' | 'fail' | 'timeout' | null = null;
  let reason = '';
  const workers: Worker[] = [];
  const finish = (v: 'pass' | 'fail' | 'timeout', why: string) => {
    if (verdict) return;
    verdict = v;
    reason = why;
    for (const w of workers) void w.terminate();
  };
  const stats = () => {
    const mean = sum / Math.max(1, hands);
    const se = Math.sqrt(Math.max(0, sumSq / Math.max(1, hands) - mean * mean) / Math.max(1, hands));
    return { mean, se };
  };
  await new Promise<void>((resolve) => {
    const wall = setTimeout(() => {
      finish('timeout', 'hard stop at 60 s');
      resolve();
    }, WALL_MS);
    let alive = THREADS;
    for (let i = 0; i < THREADS; i++) {
      // Workers do not inherit the tsx loader: a tiny bootstrap registers it, then loads this file.
      const self = JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href);
      const boot = "import('tsx/esm/api').then((m) => { m.register(); return import(" + self + "); });";
      const w = new Worker(boot, { eval: true, workerData: { seed: 0x5eed + i * 7919 } });
      workers.push(w);
      w.on('message', (b: Batch) => {
        if (verdict) return;
        if (b.error) finish('fail', 'a hand threw: ' + b.error);
        else if (!b.conserved) finish('fail', 'chips were not conserved');
        else {
          hands += b.hands;
          for (const x of b.nets) {
            sum += x;
            sumSq += x * x;
          }
          const { mean, se } = stats();
          if (hands >= MIN_HANDS && mean - 1.645 * se > 0) finish('pass', 'Sharp beats five Greenhorns at 95 % confidence');
          else if (hands >= MAX_HANDS) finish(mean > 0 ? 'pass' : 'fail', 'reached ' + MAX_HANDS + ' hands');
          else w.postMessage('more');
        }
        if (verdict) {
          clearTimeout(wall);
          resolve();
        }
      });
      w.on('error', (e) => {
        finish('fail', 'worker error: ' + e.message);
        clearTimeout(wall);
        resolve();
      });
      w.on('exit', () => {
        alive--;
        if (alive === 0 && !verdict) {
          finish('fail', 'workers exited');
          clearTimeout(wall);
          resolve();
        }
      });
    }
  });
  const { mean, se } = stats();
  console.log(
    JSON.stringify({ verdict, reason, hands, sharpBbPerHand: Number(mean.toFixed(3)), se: Number(se.toFixed(3)), lowerBound95: Number((mean - 1.645 * se).toFixed(3)), seconds: (Date.now() - started) / 1000 }),
  );
  process.exit(verdict === 'pass' ? 0 : 1);
}
