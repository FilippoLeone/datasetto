/**
 * `GlimmerHost` (glimmerhall.md §7.3): the hall's whole conversation with its authority, over the
 * platform's `TableHost`. The same adapter serves both modes: online the TableHost is the socket
 * (`glimmer:*` on the main connection), offline it wraps the local hall (hosts/local.ts), which
 * answers the same events on the device.
 *
 * Every request resolves: a rejected or timed-out request becomes `{ok: false, code: 'lost'}`, so
 * callers handle one shape. A lost spin settles later through `resume`.
 */
import type { MachineIdx } from '@arcade/core/glimmer/machines';
import type { DashSpinOk, DashView, EnterOk, FeedView, PickOk, Refused, ResumeOk, SpinOk } from '@arcade/core/glimmer/wire';
import { DEFS } from '@arcade/core/version';
import type { TableHost } from '@/arcade/runtime/types';

export const SPIN_TIMEOUT_MS = 15_000;

export interface DashCfg {
  m: MachineIdx;
  len: number;
  buy: number;
}

export type Lost = { ok: false; code: 'lost' };

export interface GlimmerHost {
  readonly mode: 'local' | 'remote';
  enter(ch: string | null): Promise<EnterOk | Refused>;
  spin(m: MachineIdx, bet: number, id: string): Promise<SpinOk | Refused>;
  pick(door: 0 | 1 | 2, id: string): Promise<PickOk | Refused>;
  resume(id: string): Promise<ResumeOk | Refused>;
  react(to: number, emote: number): void;
  /** Online: `glimmer:away` (pushes stop server-side). */
  away(): void;
  leave(): void;
  dash: {
    create(c: DashCfg): Promise<{ ok: true; dash: DashView; bal?: number } | Refused>;
    join(id: string): Promise<{ ok: true; bal?: number } | Refused>;
    leave(id: string): Promise<{ ok: true; bal?: number } | Refused>;
    start(id: string): Promise<{ ok: true } | Refused>;
    spin(id: string, sid: string): Promise<DashSpinOk | Refused>;
  };
  onFeed(cb: (f: FeedView) => void): () => void;
  /** Another device changed the wallet (online). */
  onWallet(cb: (bal: number) => void): () => void;
  /** Another tab or device took the seat. */
  onMoved(cb: () => void): () => void;
  /** The hall closed (`glimmer:closed {r}`). */
  onClosed(cb: (reason: string) => void): () => void;
  onConnection(cb: (up: boolean) => void): () => void;
  connected(): boolean;
}

export const createGlimmerHost = (t: TableHost): GlimmerHost => {
  const ask = <T>(ev: string, data: unknown, timeoutMs?: number): Promise<T | Refused> =>
    t.request<T | Refused>(ev, data, timeoutMs ? { timeoutMs } : undefined).then(
      (ack) => (ack && typeof ack === 'object' ? ack : ({ ok: false, code: 'invalid' } as Refused)),
      () => ({ ok: false, code: 'lost' }) as Refused,
    );
  /** Events the server does not acknowledge: sent and forgotten. */
  const tell = (ev: string, data: unknown): void => {
    void t.request(ev, data, { timeoutMs: 1 }).catch(() => undefined);
  };
  const listen = <T>(ev: string, cb: (data: T) => void): (() => void) => t.on(ev, (data) => cb(data as T));

  return {
    mode: t.mode,
    enter: (ch) => ask<EnterOk>('glimmer:enter', { ch, v: DEFS.glimmer }),
    spin: (m, b, id) => ask<SpinOk>('glimmer:spin', { m, b, id }, SPIN_TIMEOUT_MS),
    pick: (door, id) => ask<PickOk>('glimmer:pick', { door, id }, SPIN_TIMEOUT_MS),
    resume: (id) => ask<ResumeOk>('glimmer:resume', { id }),
    react: (to, e) => tell('glimmer:react', { to, e }),
    away: () => tell('glimmer:away', {}),
    leave: () => tell('glimmer:leave', {}),
    dash: {
      create: (c) => ask('glimmer:dash:create', c),
      join: (id) => ask('glimmer:dash:join', { id }),
      leave: (id) => ask('glimmer:dash:leave', { id }),
      start: (id) => ask('glimmer:dash:start', { id }),
      spin: (id, sid) => ask<DashSpinOk>('glimmer:dash:spin', { d: id, id: sid }, SPIN_TIMEOUT_MS),
    },
    onFeed: (cb) => listen<FeedView>('glimmer:feed', cb),
    onWallet: (cb) =>
      listen<{ bal?: unknown }>('arcade:wallet', (w) => {
        if (w && typeof w.bal === 'number') cb(w.bal);
      }),
    onMoved: (cb) => listen('glimmer:moved', () => cb()),
    onClosed: (cb) => listen<{ r?: unknown }>('glimmer:closed', (d) => cb(typeof d?.r === 'string' ? d.r : 'closed')),
    onConnection: (cb) => t.onConnection(cb),
    connected: () => t.connected(),
  };
};
