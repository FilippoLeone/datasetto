/**
 * The action bar, raise sheet, menu, history drawer and result card (lamplight.md §14.2, §14.4): one
 * Preact root inside the stage, owned by the module, reading module-local signals only. `myTurn` is
 * written at the start and end of your turn; `seatState` when your own seat changes. The voice page
 * never reads either.
 */
import { signal } from '@preact/signals';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Format, SeatStatus } from '@arcade/core/lamplight/engine';
import { chips, fullChips, type HandRecord, type PreAction, type Turn } from './table';
import { EMOTE_NAMES } from './render/art';
import type { LayoutMode } from './render/layout';

export interface SeatSummary {
  seated: boolean;
  status: SeatStatus | null;
  stack: number;
  inHand: boolean;
  folded: boolean;
  format: Format;
  local: boolean;
  balance: number | null;
  minBuyIn: number;
  maxBuyIn: number;
  bb: number;
  /** What a call would cost now (when it is not your turn), for the "Call X" pre-action. */
  owe: number;
  handRunning: boolean;
  /** You won uncontested and may show your cards. */
  showable: boolean;
  result: { place: number; prize: number } | null;
  buyIn: number;
  sitOutNext: boolean;
  /** Online only: why you cannot play (old app version, signed out). */
  blocked: string | null;
  /** You may sit down (cash, a seat free) or register (a Cup or Trio before its start). */
  joinable: boolean;
  /** Hands have been played here (a newcomer chooses to post a big blind or wait for it). */
  running: boolean;
}

export const EMPTY_SEAT: SeatSummary = {
  seated: false,
  status: null,
  stack: 0,
  inHand: false,
  folded: false,
  format: 'open',
  local: true,
  balance: null,
  minBuyIn: 0,
  maxBuyIn: 0,
  bb: 10,
  owe: 0,
  handRunning: false,
  showable: false,
  result: null,
  buyIn: 0,
  sitOutNext: false,
  blocked: null,
  joinable: true,
  running: false,
};

export interface BarApi {
  act(k: string, a?: number): void;
  preAction(p: PreAction, call: number): void;
  sitOut(on: boolean): void;
  topUp(amount: number): void;
  refill(): void;
  join(buyIn: number, post: 'now' | 'wait'): void;
  emote(id: number): void;
  /** Draw emote `id` into a small canvas. */
  paintEmote(canvas: HTMLCanvasElement, id: number): void;
  /** Online: older hands from the server, 20 per page. */
  older(before: number | null): Promise<OlderHand[]>;
  /** Online: one older hand as lines, and its deck check. */
  open(row: OlderHand): Promise<{ lines: string[]; check: () => Promise<string> }>;
  leave(): void;
  show(): void;
  fast(on: boolean): void;
  deck(two: boolean): void;
  verify(rec: HandRecord): Promise<string>;
  history(): readonly HandRecord[];
  hints(): { call: string; fold: string; raise: string };
}

export interface OlderHand {
  id: number;
  t: string;
  h: number;
  at: number;
  label: string;
  net: number;
  pot: number;
}

/** Module-local signals (one set per mounted table). */
export const createBarState = () => ({
  myTurn: signal<Turn | null>(null),
  seatState: signal<SeatSummary>(EMPTY_SEAT),
  mode: signal<LayoutMode>('portrait'),
  sheet: signal(false),
  amount: signal(0),
  menu: signal(false),
  drawer: signal(false),
  hint: signal<string | null>(null),
  pre: signal<PreAction>(null),
  fast: signal(false),
  twoColour: signal(false),
  allinArmed: signal(0),
  postNow: signal(false),
  emotes: signal(false),
  emoteAt: signal(0),
});
export type BarState = ReturnType<typeof createBarState>;

const btn = 'min-h-12 min-w-12 rounded-md px-3 text-sm font-semibold disabled:opacity-40';
const solid = btn + ' bg-[#b08d57] text-[#1b1b24] hover:bg-[#c9a46a] active:bg-[#f2b84b]';
const quiet = btn + ' bg-[#24302e] text-[#f4ead5] hover:bg-[#2f3e3b]';
const danger = btn + ' bg-[#3a2326] text-[#ffd9d9] hover:bg-[#4a2b2f]';

const clampTo = (v: number, t: Turn): number => Math.max(t.minTo, Math.min(t.maxTo, Math.round(v)));

const RaiseSheet = ({ s, api, t }: { s: BarState; api: BarApi; t: Turn }) => {
  const amount = s.amount.value || t.minTo;
  const set = (v: number) => {
    s.amount.value = clampTo(Math.round(v / Math.max(1, t.sb)) * Math.max(1, t.sb), t);
  };
  const potTo = (f: number) => t.currentBet + Math.round((t.pot + t.toCall) * f);
  const confirm = () => {
    s.sheet.value = false;
    if (amount >= t.maxTo) api.act('a');
    else api.act(t.currentBet === 0 ? 'b' : 'r', amount);
  };
  const allin = () => {
    const now = Date.now();
    if (now - s.allinArmed.value < 2000) {
      s.sheet.value = false;
      s.allinArmed.value = 0;
      api.act('a');
    } else {
      s.allinArmed.value = now;
      s.amount.value = t.maxTo;
    }
  };
  return (
    <div class="pointer-events-auto absolute inset-x-2 bottom-[calc(100%+6px)] rounded-lg bg-[#121c1b]/95 p-3 shadow-modal" data-ll-sheet>
      <div class="mb-2 flex flex-wrap gap-2">
        {[
          ['Min', t.minTo],
          ['½', potTo(0.5)],
          ['¾', potTo(0.75)],
          ['Pot', potTo(1)],
        ].map(([label, v]) => (
          <button type="button" class={quiet} onClick={() => set(Number(v))} disabled={Number(v) < t.minTo && t.minTo >= t.maxTo}>
            {label}
          </button>
        ))}
        <button type="button" class={danger} onClick={allin} data-ll-allin>
          {s.allinArmed.value && Date.now() - s.allinArmed.value < 2000 ? 'Tap again' : 'All-in'}
        </button>
      </div>
      <div class="flex items-center gap-2">
        <button type="button" class={quiet} aria-label="One big blind less" onClick={() => set((s.amount.peek() || t.minTo) - t.bb)}>
          −
        </button>
        <input
          type="range"
          class="min-w-0 flex-1 accent-[#f2b84b]"
          min={t.minTo}
          max={t.maxTo}
          step={Math.max(1, t.sb)}
          value={amount}
          aria-label="Raise to"
          onInput={(e) => set(Number((e.target as HTMLInputElement).value))}
        />
        <button type="button" class={quiet} aria-label="One big blind more" onClick={() => set((s.amount.peek() || t.minTo) + t.bb)}>
          +
        </button>
        <input
          type="text"
          inputMode="numeric"
          class="h-12 w-24 rounded-md bg-[#0d1716] px-2 text-right text-sm text-[#f4ead5]"
          aria-label="Amount"
          value={String(amount)}
          onChange={(e) => set(Number((e.target as HTMLInputElement).value.replace(/\D/g, '')) || t.minTo)}
        />
        <button type="button" class={solid} onClick={confirm} data-ll-confirm>
          {amount >= t.maxTo ? 'All-in' : (t.currentBet === 0 ? 'Bet ' : 'Raise to ') + chips(amount)}
        </button>
      </div>
    </div>
  );
};

const Drawer = ({ s, api }: { s: BarState; api: BarApi }) => {
  const [open, setOpen] = useState<number | null>(null);
  const [verdict, setVerdict] = useState<Record<number, string>>({});
  const list = api.history();
  return (
    <div class="pointer-events-auto absolute inset-y-0 left-0 z-10 flex w-[min(360px,100%)] flex-col bg-[#0f1716]/97 shadow-modal" data-ll-drawer>
      <div class="flex h-12 items-center justify-between border-b border-white/10 px-3">
        <span class="text-sm font-semibold text-[#f4ead5]">Hand history</span>
        <button type="button" class={quiet} onClick={() => (s.drawer.value = false)}>
          Close
        </button>
      </div>
      <div class="scrollbar-thin flex-1 overflow-y-auto p-2 text-xs text-[#d8d2c2]">
        {list.length === 0 && <p class="p-2 text-[#9aa3a0]">No hands yet.</p>}
        {list.map((h) => (
          <div key={h.no + ':' + h.at} class="mb-1 rounded-md bg-white/5">
            <button type="button" class="flex min-h-11 w-full items-center justify-between px-2 text-left" onClick={() => setOpen(open === h.no ? null : h.no)}>
              <span>
                Hand {h.no} · {h.label}
              </span>
              <span class={h.net > 0 ? 'text-[#7fd49a]' : h.net < 0 ? 'text-[#f08a8a]' : 'text-[#9aa3a0]'}>{h.done ? (h.net > 0 ? '+' : '') + fullChips(h.net) : '…'}</span>
            </button>
            {open === h.no && (
              <div class="px-2 pb-2">
                {h.lines.map((l) => (
                  <p class="leading-5">{l}</p>
                ))}
                {h.seed !== null && <p class="mt-1 text-[#9aa3a0]">Practice hand · deck seed {h.seed}</p>}
                {h.cr && h.done && (
                  <div class="mt-2">
                    <button type="button" class={quiet} onClick={() => void api.verify(h).then((v) => setVerdict({ ...verdict, [h.no]: v }))}>
                      Verify deck
                    </button>
                    {verdict[h.no] && <p class="mt-1">{verdict[h.no]}</p>}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {!s.seatState.value.local && <Older api={api} />}
        <p class="mt-3 px-1 leading-5 text-[#9aa3a0]">
          The deck check shows that the cards did not change during a hand. It cannot stop whoever runs the server from choosing the deck, and nothing can stop
          friends from telling each other their cards over voice. Chips here are play chips only.
        </p>
      </div>
    </div>
  );
};

/** Hands from before this session (the server keeps 30 days), 20 per page. */
const Older = ({ api }: { api: BarApi }) => {
  const [rows, setRows] = useState<OlderHand[] | null>(null);
  const [more, setMore] = useState(true);
  const [open, setOpen] = useState<{ id: number; lines: string[]; check: () => Promise<string>; verdict: string | null } | null>(null);
  const load = () =>
    void api.older(rows && rows.length ? rows[rows.length - 1].id : null).then((page) => {
      setRows([...(rows ?? []), ...page]);
      if (page.length < 20) setMore(false);
    });
  if (!rows)
    return (
      <button type="button" class={quiet + ' mt-2 w-full'} onClick={load}>
        Older hands
      </button>
    );
  return (
    <div class="mt-2">
      <p class="px-1 pb-1 font-semibold text-[#f4ead5]">Older hands</p>
      {rows.length === 0 && <p class="p-2 text-[#9aa3a0]">None in the last 30 days.</p>}
      {rows.map((r) => (
        <div key={r.id} class="mb-1 rounded-md bg-white/5">
          <button
            type="button"
            class="flex min-h-11 w-full items-center justify-between px-2 text-left"
            onClick={() => (open?.id === r.id ? setOpen(null) : void api.open(r).then((o) => setOpen({ id: r.id, ...o, verdict: null })))}
          >
            <span>
              Hand {r.h} · {r.label}
            </span>
            <span class={r.net > 0 ? 'text-[#7fd49a]' : r.net < 0 ? 'text-[#f08a8a]' : 'text-[#9aa3a0]'}>{(r.net > 0 ? '+' : '') + fullChips(r.net)}</span>
          </button>
          {open?.id === r.id && (
            <div class="px-2 pb-2">
              {open.lines.map((l) => (
                <p class="leading-5">{l}</p>
              ))}
              <button type="button" class={quiet + ' mt-2'} onClick={() => void open.check().then((v) => setOpen({ ...open, verdict: v }))}>
                Verify deck
              </button>
              {open.verdict && <p class="mt-1">{open.verdict}</p>}
            </div>
          )}
        </div>
      ))}
      {more && rows.length > 0 && (
        <button type="button" class={quiet + ' w-full'} onClick={load}>
          More
        </button>
      )}
    </div>
  );
};

/** Six pixel emotes, at most one every 3 s. */
const Emotes = ({ s, api }: { s: BarState; api: BarApi }) => (
  <div class="pointer-events-auto absolute top-12 right-14 z-10 grid grid-cols-3 gap-1 rounded-lg bg-[#121c1b]/97 p-2 shadow-modal" data-ll-emotes>
    {EMOTE_NAMES.map((name, id) => (
      <button
        type="button"
        class={quiet + ' flex items-center justify-center'}
        aria-label={name}
        title={name}
        disabled={Date.now() - s.emoteAt.value < 3000}
        onClick={() => {
          s.emotes.value = false;
          s.emoteAt.value = Date.now();
          api.emote(id);
        }}
      >
        <canvas width={24} height={24} style={{ width: '24px', height: '24px', imageRendering: 'pixelated' }} ref={(c) => {
            if (c) api.paintEmote(c, id);
          }}
        />
      </button>
    ))}
  </div>
);

const Menu = ({ s, api, seat }: { s: BarState; api: BarApi; seat: SeatSummary }) => (
  <div class="pointer-events-auto absolute top-12 right-2 z-10 flex w-56 flex-col gap-1 rounded-lg bg-[#121c1b]/97 p-2 shadow-modal" data-ll-menu>
    <button
      type="button"
      class={quiet + ' text-left'}
      onClick={() => {
        s.menu.value = false;
        s.drawer.value = true;
      }}
    >
      Hand history (H)
    </button>
    {seat.format === 'open' && seat.seated && (
      <button type="button" class={quiet + ' text-left'} onClick={() => api.sitOut(!seat.sitOutNext)}>
        {seat.sitOutNext ? 'Sit back in' : 'Sit out next hand'}
      </button>
    )}
    {seat.format === 'open' && seat.seated && seat.status !== 'busted' && seat.stack < seat.maxBuyIn && !(seat.handRunning && seat.inHand) && (
      <button
        type="button"
        class={quiet + ' text-left'}
        onClick={() => {
          s.menu.value = false;
          api.topUp(seat.maxBuyIn - seat.stack);
        }}
      >
        Top up to {chips(seat.maxBuyIn)}
      </button>
    )}
    {seat.local && (
      <button type="button" class={quiet + ' text-left'} onClick={() => api.fast((s.fast.value = !s.fast.value))}>
        Fast bots: {s.fast.value ? 'on' : 'off'}
      </button>
    )}
    <button type="button" class={quiet + ' text-left'} onClick={() => api.deck((s.twoColour.value = !s.twoColour.value))}>
      Deck: {s.twoColour.value ? 'two colours' : 'four colours'}
    </button>
    <button type="button" class={danger + ' text-left'} onClick={() => api.leave()}>
      {seat.format === 'open' ? 'Leave table' : 'Leave'}
    </button>
  </div>
);

const Bar = ({ s, api }: { s: BarState; api: BarApi }) => {
  const t = s.myTurn.value;
  const seat = s.seatState.value;
  const mode = s.mode.value;
  const hints = api.hints();
  const [buy, setBuy] = useState(0);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hint = s.hint.value;
  useEffect(() => {
    if (!hint) return;
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => (s.hint.value = null), 2500);
    return () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, [hint, s]);
  const column = mode === 'landscape';
  const wrap = column
    ? 'pointer-events-auto absolute inset-y-0 right-0 flex w-24 flex-col justify-end gap-2 p-2'
    : mode === 'desktop'
      ? 'pointer-events-auto absolute right-2 bottom-2 flex w-[372px] flex-wrap justify-end gap-2 rounded-lg bg-[#0d1716]/80 p-2'
      : 'pointer-events-auto absolute inset-x-0 bottom-0 flex h-16 items-center gap-2 bg-[#0d1716]/92 px-2';
  const grow = column ? 'w-full' : 'flex-1';
  const pre = (p: PreAction, label: string) => (
    <button
      type="button"
      aria-pressed={s.pre.value === p}
      class={(s.pre.value === p ? solid : quiet) + ' ' + grow}
      onClick={() => {
        const next = s.pre.value === p ? null : p;
        s.pre.value = next;
        api.preAction(next, seat.owe);
      }}
    >
      {label}
    </button>
  );

  let body;
  if (seat.blocked) body = <p class="flex-1 text-center text-sm text-[#f4ead5]">{seat.blocked}</p>;
  else if (seat.result) {
    body = (
      <>
        <p class={'text-sm text-[#f4ead5] ' + grow}>
          {seat.result.place === 1 ? 'You won! ' : 'You finished ' + ordinal(seat.result.place) + '. '}
          {seat.result.prize > 0 ? 'Prize: ' + fullChips(seat.result.prize) + ' chips.' : ''}
        </p>
        <button type="button" class={solid} onClick={() => api.leave()}>
          Done
        </button>
      </>
    );
  } else if (!seat.seated && !seat.joinable) {
    body = <p class={'text-center text-sm text-[#9aa3a0] ' + grow}>Watching</p>;
  } else if (!seat.seated) {
    const cost = seat.format === 'open' ? buy || seat.maxBuyIn : seat.buyIn;
    const short = seat.balance !== null && seat.balance < (seat.format === 'open' ? seat.minBuyIn : seat.buyIn);
    body = short ? (
      <>
        <p class={'text-sm text-[#f4ead5] ' + grow}>Not enough {seat.local ? 'practice ' : ''}chips.</p>
        {seat.local && (
          <button type="button" class={solid} onClick={() => api.refill()}>
            Refill to 10,000
          </button>
        )}
      </>
    ) : (
      <>
        {seat.format === 'open' && seat.maxBuyIn > seat.minBuyIn && !column && (
          <input
            type="range"
            class="min-w-0 flex-1 accent-[#f2b84b]"
            min={seat.minBuyIn}
            max={seat.maxBuyIn}
            step={seat.bb}
            value={cost}
            aria-label="Buy-in"
            onInput={(e) => setBuy(Number((e.target as HTMLInputElement).value))}
          />
        )}
        {seat.format === 'open' && seat.running && !seat.local && (
          <label class="flex min-h-12 items-center gap-1 text-xs text-[#f4ead5]">
            <input type="checkbox" checked={s.postNow.value} onChange={(e) => (s.postNow.value = (e.target as HTMLInputElement).checked)} />
            Post BB now
          </label>
        )}
        <button type="button" class={solid + ' ' + (column ? 'w-full' : '')} onClick={() => api.join(cost, s.postNow.value ? 'now' : 'wait')} data-ll-join>
          {seat.format === 'open' ? 'Sit · ' + chips(cost) : 'Join · ' + chips(cost)}
        </button>
      </>
    );
  } else if (seat.status === 'busted' && seat.format === 'open') {
    body = (
      <>
        <p class={'text-sm text-[#f4ead5] ' + grow}>Out of chips.</p>
        <button type="button" class={solid} onClick={() => api.topUp(seat.maxBuyIn)} disabled={seat.balance !== null && seat.balance < seat.minBuyIn}>
          Rebuy {chips(seat.maxBuyIn)}
        </button>
        {seat.local && seat.balance !== null && seat.balance < seat.minBuyIn && (
          <button type="button" class={quiet} onClick={() => api.refill()}>
            Refill
          </button>
        )}
      </>
    );
  } else if (t) {
    body = (
      <>
        <button type="button" class={danger + ' ' + grow} onClick={() => api.act('f')} data-ll-fold title={'Fold (' + hints.fold + ')'}>
          Fold
        </button>
        <button type="button" class={quiet + ' ' + grow} onClick={() => api.act(t.canCheck ? 'x' : t.call >= t.stack ? 'a' : 'c')} data-ll-call title={hints.call}>
          {t.canCheck ? 'Check' : t.call >= t.stack ? 'All-in ' + chips(t.call) : 'Call ' + chips(t.call)}
        </button>
        <button
          type="button"
          class={solid + ' ' + grow}
          disabled={!t.canRaise}
          onClick={() => {
            s.amount.value = s.amount.value || t.minTo;
            s.sheet.value = !s.sheet.value;
          }}
          data-ll-raise
          title={hints.raise}
        >
          {t.currentBet === 0 ? 'Bet' : 'Raise'}
        </button>
      </>
    );
  } else if (seat.showable) {
    body = (
      <button type="button" class={quiet + ' ' + grow} onClick={() => api.show()}>
        Show cards
      </button>
    );
  } else if (seat.handRunning && seat.inHand && !seat.folded) {
    body = (
      <>
        {pre('checkFold', 'Check/Fold')}
        {seat.owe > 0 ? pre('call', 'Call ' + chips(seat.owe)) : pre('check', 'Check')}
        {pre('callAny', 'Call any')}
      </>
    );
  } else {
    body =
      seat.status === 'sittingOut' ? (
        <>
          <p class={'text-sm text-[#9aa3a0] ' + grow}>Sitting out</p>
          <button type="button" class={solid} onClick={() => api.sitOut(false)} data-ll-sitin>
            Sit back in
          </button>
        </>
      ) : (
        <p class={'text-center text-sm text-[#9aa3a0] ' + grow}>{seat.status === 'waiting' ? 'Waiting for the big blind' : 'Waiting for the next hand'}</p>
      );
  }

  return (
    <div class="pointer-events-none absolute inset-0 select-none" data-ll-ui>
      <button
        type="button"
        class="pointer-events-auto absolute top-2 right-2 flex h-11 min-w-11 items-center justify-center rounded-md bg-[#121c1b]/85 px-3 text-sm font-semibold text-[#f4ead5]"
        aria-label="Table menu"
        aria-expanded={s.menu.value}
        onClick={() => (s.menu.value = !s.menu.value)}
      >
        ···
      </button>
      {seat.balance !== null && (
        <span class="absolute top-3 left-2 rounded bg-black/40 px-1.5 py-0.5 text-[11px] text-[#d8d2c2]" data-ll-balance>
          {fullChips(seat.balance)} {seat.local ? 'practice chips' : 'chips'}
        </span>
      )}
      {seat.seated && (
        <button
          type="button"
          class="pointer-events-auto absolute top-2 right-16 flex h-11 min-w-11 items-center justify-center rounded-md bg-[#121c1b]/85 px-3 text-sm font-semibold text-[#f4ead5]"
          aria-label="Emotes"
          aria-expanded={s.emotes.value}
          onClick={() => (s.emotes.value = !s.emotes.value)}
        >
          :)
        </button>
      )}
      {s.emotes.value && <Emotes s={s} api={api} />}
      {s.menu.value && <Menu s={s} api={api} seat={seat} />}
      {s.drawer.value && <Drawer s={s} api={api} />}
      <div class={wrap} data-ll-bar>
        {s.hint.value && <p class="absolute -top-7 left-2 rounded bg-black/70 px-2 py-0.5 text-xs text-[#f4ead5]">{s.hint.value}</p>}
        {t && s.sheet.value && <RaiseSheet s={s} api={api} t={t} />}
        {body}
      </div>
    </div>
  );
};

const ordinal = (n: number): string => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');

/** Mount the bar into `el`; returns the unmount function. */
export const mountBar = (el: HTMLElement, s: BarState, api: BarApi): (() => void) => {
  render(<Bar s={s} api={api} />, el);
  return () => render(null, el);
};
