import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Bot, ChevronDown, ChevronLeft, Minus, Plus, SlidersHorizontal, Trophy, User, UserPlus } from 'lucide-preact';
import { Button, Sheet } from '@/components';
import { isTouchPrimary } from '@/lib/device';
import { cn } from '@/lib/cn';
import { CATALOG, defaultOptions, metaOf, type GameMeta } from '@/arcade/catalog';
import type { LobbyView } from '@/arcade/runtime/types';
import { usersInVoice, users } from '@/state/presence';
import { account } from '@/state/session';
import { voiceChannelId, voiceStatus } from '@/state/voice';
import { inviteToLobby, listSaves, refusalText, setLobbyBots, setLobbyConfig, startLobby, type Ack, type JoinAs } from './api';
import { ArcadePrefs } from './ArcadePrefs';
import { offlineGames } from './ArcadeOverlay';
import { forgetLobby } from './bindings';
import { BoardsPanel } from './BoardsPanel';
import { GameCard, GameIcon } from './GameCard';
import { activitySummary } from './LobbyChip';
import { SetupForm } from './LobbyForm';
import { createGame, joinGame, leaveCurrent, reopenStage } from './remote';
import { cfgFor, fieldsFor, fieldSummary, fillNewTale, hasOptions, resolveSetup, saveSetup, saveSlotField, storedSetup, summaryOf, withSaveSlot, type SlotInfo } from './setup';
import { arcadeActivity, arcadeLobby, arcadeStage, arcadeWallet, gameEnabled, gameHidden, openArcade, type ActivityEntry } from './state';
import { WalletPill } from './WalletPill';

/** One line of the channel's activity: "Fuseyard · 2/4 · playing". */
export const activityLabel = (entry: ActivityEntry): string =>
  activitySummary(entry) + ' · ' + (entry.st === 'live' ? 'playing' : entry.st === 'dash' ? 'Glimmer Dash' : entry.st === 'open' ? 'open' : 'setting up');

/** Games that can be started online here: built for it, switched on, not hidden by the account. */
export const onlineGames = (): GameMeta[] => CATALOG.filter((meta) => meta.ready.online && meta.modes.some((m) => m.online) && gameEnabled(meta.id) && !gameHidden(meta.id));

/** Sheet buttons and rows: ≥ 44 px touch targets. */
const SHEET_BUTTON = 'flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors disabled:opacity-50';
const PRIMARY = 'bg-brand text-white hover:bg-brand-hover';
const SECONDARY = 'bg-active text-text-bright hover:bg-hover';
const TEXT = 'text-text hover:bg-hover hover:text-text-bright';

/** Join rows shown before "Show N more". */
const ROWS = 3;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const plural = (n: number, one: string, many: string): string => n + ' ' + (n === 1 ? one : many);

/** Desktop: a 320 px popover under the Arcade button. The body scrolls; the footer and its buttons stay put. */
const Popover = ({ anchor, onClose, children }: { anchor: HTMLElement | null; onClose(): void; children: ComponentChildren }) => {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const rect = anchor?.getBoundingClientRect();
    const width = 320;
    if (!rect) {
      setPos({ top: 64, left: Math.max(8, window.innerWidth - width - 8) });
      return;
    }
    setPos({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) });
  }, [anchor]);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Arcade"
      className="fixed z-[70] flex w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg bg-sidebar shadow-modal animate-pop"
      style={pos ? { top: pos.top + 'px', left: pos.left + 'px', maxHeight: 'calc(100dvh - ' + (pos.top + 8) + 'px)' } : { visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
};

const Title = ({ children }: { children: ComponentChildren }) => <p className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">{children}</p>;

const Row = ({ icon, label, detail, onSelect, testId }: { icon: ComponentChildren; label: string; detail?: string; onSelect(): void; testId?: string }) => (
  <button type="button" onClick={onSelect} className="flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left hover:bg-hover active:bg-active" data-arcade-row={testId}>
    <span className="flex w-5 shrink-0 justify-center text-text-muted">{icon}</span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm text-text-bright">{label}</span>
      {detail && <span className="block truncate text-xs text-text-muted">{detail}</span>}
    </span>
  </button>
);

/** A text button that opens or closes a part of the sheet ("Show 2 more", "Start a different game"). */
const Disclosure = ({ open, label, onToggle, testId }: { open: boolean; label: string; onToggle(): void; testId: string }) => (
  <button
    type="button"
    aria-expanded={open}
    onClick={onToggle}
    data-arcade-disclosure={testId}
    className="flex min-h-11 w-full items-center gap-1.5 rounded-md px-3 text-left text-sm font-medium text-text-muted transition-colors hover:bg-hover hover:text-text-bright"
  >
    <ChevronDown size={16} className={cn('shrink-0 transition-transform', open && 'rotate-180')} />
    {label}
  </button>
);

const accountNames = (): Map<string, string> => new Map(users.value.map((user) => [user.accountId, user.displayName]));

/** "2 of 4 · waiting", "Playing", "Open · 3 at the table", "3 playing". */
const entryState = (entry: ActivityEntry): string =>
  (entry.st === 'lobby'
    ? entry.n + ' of ' + entry.max + ' · waiting'
    : entry.st === 'live'
      ? 'Playing'
      : entry.st === 'dash'
        ? 'Glimmer Dash · ' + entry.n + ' playing'
        : entry.g === 'glimmer'
          ? entry.n + ' playing'
          : 'Open · ' + entry.n + ' at the table') + (entry.w > 0 ? ' · ' + entry.w + ' watching' : '');

/** One of this channel's games you are not in: Join, and Watch where the game offers it. */
const EntryRow = ({ entry, onAct }: { entry: ActivityEntry; onAct(id: string, as: JoinAs): void }) => {
  const meta = metaOf(entry.g);
  // A Glimmerhall hall stays open while a Glimmer Dash runs inside it: only the Dash can't be joined.
  const join = entry.n < entry.max;
  return (
    <div className="flex min-h-12 items-center gap-2 rounded-md px-3" data-arcade-row={'activity-' + entry.id}>
      <span className="flex w-5 shrink-0 justify-center text-text-muted">{meta && <GameIcon icon={meta.icon} size={16} />}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text-bright">{(meta?.name ?? entry.g) + (entry.x ? ' · ' + entry.x : '')}</span>
        <span className="block truncate text-xs text-text-muted">{entryState(entry)}</span>
      </span>
      {join && (
        <button type="button" className={cn(SHEET_BUTTON, PRIMARY)} onClick={() => onAct(entry.id, 'player')} data-arcade-join={entry.id}>
          Join
        </button>
      )}
      {meta?.watch && (
        <button type="button" className={cn(SHEET_BUTTON, TEXT, 'px-2')} onClick={() => onAct(entry.id, 'spectator')} data-arcade-watch={entry.id}>
          Watch
        </button>
      )}
    </div>
  );
};

/**
 * "Your game": the lobby you are in, in a few lines (who is in, what was set at create) with Start,
 * Invite and Leave. The host of a forming action game may change what the lobby allows (Change).
 */
const YourGame = ({ lobby, onInvite, onError }: { lobby: LobbyView; onInvite(): void; onError(text: string | null): void }) => {
  const meta = metaOf(lobby.game);
  const me = account.value?.id ?? null;
  const isHost = lobby.host === me;
  const names = accountNames();
  const stage = arcadeStage.value;
  const [bots, setBots] = useState(0);
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  const humans = lobby.seats.filter((seat) => seat.a).length;
  const hostBots = meta?.hostBots !== false;
  const botCount = hostBots ? Math.min(bots, lobby.seats.length - humans) : 0;
  const forming = lobby.st === 'open';
  const table = meta?.lane === 'table';
  const cfg = isRecord(lobby.cfg) ? lobby.cfg : {};
  const nameOf = (id: string) => names.get(id) ?? 'Player';

  const run = async (call: () => Promise<Ack>) => {
    setBusy(true);
    const answer = await call();
    setBusy(false);
    if (answer.ok) return onError(null);
    if (answer.code === 'gone') forgetLobby(lobby.id);
    onError(refusalText(answer.code));
  };
  const changeBots = (n: number) => {
    const next = Math.max(0, Math.min(lobby.seats.length - humans, n));
    setBots(next);
    void run(() => setLobbyBots(lobby.id, next, 1));
  };

  const status =
    lobby.st === 'live' ? 'Playing' + (lobby.spec > 0 ? ' · ' + lobby.spec + ' watching' : '') : isHost ? "You're the host · waiting for players" : 'Waiting for ' + nameOf(lobby.host) + ' to start';
  let people: string;
  if (table) people = humans > 0 ? humans + ' at the table' : 'Nobody seated yet';
  else {
    const seated = lobby.seats.filter((seat) => seat.a).map((seat) => nameOf(seat.a as string) + (seat.a === lobby.host ? ' (host)' : '') + (seat.st === 1 ? ' (reconnecting)' : ''));
    const open = lobby.seats.length - humans - botCount - lobby.seats.filter((seat) => !seat.a && seat.bot).length;
    const botSeats = lobby.seats.filter((seat) => !seat.a && seat.bot).length + botCount;
    people = seated.join(', ') + (botSeats > 0 ? ' · ' + plural(botSeats, 'bot', 'bots') : '') + (forming && open > 0 ? ' · ' + plural(open, 'open seat', 'open seats') : '');
  }
  // Action games: what fills the empty seats, and what the lobby may still change.
  const fields = meta && !table ? fieldsFor(meta, 'online', lobby.mode, cfg) : null;
  const botField = fields?.all.find((f) => f.key === 'bots' && f.kind === 'choice');
  const fill = meta && fields && forming ? (botField ? 'Empty seats become ' + fieldSummary(botField, cfg) : meta.hostBots === false ? 'Friends can drop in any time' : null) : null;
  const editable = meta && !table ? fieldsFor(meta, 'online', lobby.mode, cfg, 'lobby').all : [];
  const canChange = Boolean(meta) && isHost && forming && editable.length > 0;

  return (
    <section className="mx-1 mb-1 flex flex-col gap-1 rounded-md bg-base/60 p-3" data-arcade-lobby={lobby.id}>
      <p className="line-clamp-2 text-sm font-semibold text-text-bright">{(meta?.name ?? lobby.game) + ' · ' + (meta?.modes.find((m) => m.id === lobby.mode)?.label ?? lobby.mode)}</p>
      <p className="text-xs text-text-muted">{status}</p>
      <p className="flex items-start gap-1.5 pt-1 text-xs text-text" data-arcade-people>
        <User size={14} className="mt-px shrink-0 text-text-muted" />
        <span className="min-w-0">{people}</span>
      </p>
      {fill && <p className="pl-5 text-xs text-text-muted">{fill}</p>}
      {meta && editable.length > 0 && (
        <div className="flex min-h-11 items-center gap-2" data-arcade-lobby-options>
          <p className="min-w-0 flex-1 text-xs text-text-muted">{summaryOf(meta, 'online', lobby.mode, cfg, { all: true, editable: 'lobby' })}</p>
          {canChange && (
            <button type="button" aria-expanded={changing} className={cn(SHEET_BUTTON, TEXT, 'px-2 text-[#a3abff]')} onClick={() => setChanging((open) => !open)} data-arcade-change>
              {changing ? 'Done' : 'Change'}
            </button>
          )}
        </div>
      )}
      {canChange && changing && meta && (
        <div className="py-2">
          <SetupForm
            meta={meta}
            where="online"
            mode={lobby.mode}
            values={cfg}
            lockMode
            editable="lobby"
            onMode={() => undefined}
            onChange={(key, value) => void run(() => setLobbyConfig(lobby.id, cfgFor(meta, 'online', lobby.mode, { ...cfg, [key]: value })))}
          />
        </div>
      )}
      {isHost && forming && hostBots && (
        <div className="flex items-center gap-1 text-sm">
          <span className="flex flex-1 items-center gap-2 text-text-bright">
            <Bot size={16} className="text-text-muted" /> Bots in free seats
          </span>
          <button type="button" className={cn(SHEET_BUTTON, 'min-w-11 px-0 hover:bg-hover')} aria-label="Fewer bots" disabled={busy || botCount === 0} onClick={() => changeBots(botCount - 1)}>
            <Minus size={16} />
          </button>
          <span className="w-6 text-center tabular-nums" data-arcade-bots>
            {botCount}
          </span>
          <button type="button" className={cn(SHEET_BUTTON, 'min-w-11 px-0 hover:bg-hover')} aria-label="More bots" disabled={busy || botCount >= lobby.seats.length - humans} onClick={() => changeBots(botCount + 1)}>
            <Plus size={16} />
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {isHost && forming && (
          <button
            type="button"
            className={cn(SHEET_BUTTON, 'bg-success text-white hover:bg-[#1a8a49]')}
            disabled={busy || humans + botCount < (hostBots ? (meta?.seats[0] ?? 1) : 1)}
            onClick={() => void run(() => startLobby(lobby.id))}
            data-arcade-start-lobby
          >
            Start
          </button>
        )}
        {lobby.st === 'live' && stage?.lobbyId !== lobby.id && (
          <button type="button" className={cn(SHEET_BUTTON, PRIMARY)} onClick={reopenStage} data-arcade-open-game>
            Open game
          </button>
        )}
        <button type="button" className={cn(SHEET_BUTTON, SECONDARY)} onClick={onInvite} data-arcade-invite-open>
          <UserPlus size={16} /> Invite
        </button>
        <button type="button" className={cn(SHEET_BUTTON, TEXT)} onClick={leaveCurrent} data-arcade-leave-lobby>
          Leave
        </button>
      </div>
    </section>
  );
};

/** Ping one voice member (at most once a minute per pair; never pops anything up for them). */
const InvitePanel = ({ lobby }: { lobby: LobbyView }) => {
  const [sent, setSent] = useState<Record<string, string>>({});
  const me = account.value?.id;
  const seated = new Set(lobby.seats.map((seat) => seat.a));
  const seen = new Set<string>();
  const people = usersInVoice(lobby.ch).filter((user) => {
    if (user.accountId === me || seated.has(user.accountId) || seen.has(user.accountId)) return false;
    seen.add(user.accountId);
    return true;
  });
  const invite = async (accountId: string) => {
    setSent((prev) => ({ ...prev, [accountId]: 'Sending…' }));
    const answer = await inviteToLobby(lobby.id, accountId);
    setSent((prev) => ({ ...prev, [accountId]: answer.ok ? 'Invited' : answer.code === 'busy' ? 'Invited in the last minute' : refusalText(answer.code) }));
  };
  if (people.length === 0) return <p className="px-3 py-2 text-sm text-text-muted">Everyone in the call is already in this game.</p>;
  return (
    <ul className="flex flex-col py-1">
      {people.map((user) => (
        <li key={user.accountId} className="flex min-h-12 items-center gap-2 px-3">
          <span className="min-w-0 flex-1 truncate text-sm text-text-bright">{user.displayName}</span>
          {sent[user.accountId] ? (
            <span className="text-xs text-text-muted">{sent[user.accountId]}</span>
          ) : (
            <button type="button" className={cn(SHEET_BUTTON, SECONDARY)} onClick={() => void invite(user.accountId)} data-arcade-invite-to={user.accountId}>
              Invite
            </button>
          )}
        </li>
      ))}
    </ul>
  );
};

/** The setup screen of one game in a call; `picked` once the host chooses a tale by hand. */
interface SetupView {
  kind: 'setup';
  meta: GameMeta;
  mode: string;
  values: Record<string, unknown>;
  /** `arcade:saves` for a game with save slots; undefined until it answers. */
  slots?: readonly SlotInfo[];
  picked: boolean;
}

type View = { kind: 'main' } | SetupView | { kind: 'invite' } | { kind: 'boards' } | { kind: 'prefs' };

const setupView = (meta: GameMeta): SetupView => ({ kind: 'setup', meta, ...resolveSetup(meta, 'online'), picked: false });

/**
 * The Arcade sheet (platform.md §9.2, §10.6): a bottom sheet on touch screens, a popover elsewhere.
 * Top to bottom: your game here (if any); play with your call (Join this channel's games, or start
 * one in a tap); play solo; a footer with the chips, the boards and this device's game settings.
 * Opening it changes nothing for anyone else.
 */
export const ArcadeSheet = ({ channelId, anchor, onClose }: { channelId: string | null; anchor: HTMLElement | null; onClose(): void }) => {
  const [view, setView] = useState<View>({ kind: 'main' });
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [allRows, setAllRows] = useState(false);
  const [otherGame, setOtherGame] = useState(false);
  const lobby = arcadeLobby.value;
  const here = lobby && channelId && lobby.ch === channelId ? lobby : null;
  const entries = (channelId ? (arcadeActivity.value.get(channelId) ?? []) : []).filter((entry) => entry.id !== here?.id && !gameHidden(entry.g) && gameEnabled(entry.g));
  const online = onlineGames();
  const inVoice = channelId !== null && voiceChannelId.value === channelId && voiceStatus.value !== 'idle';
  const solo = offlineGames();
  const chipGames = online.some((meta) => meta.chips);
  const touch = isTouchPrimary();

  // Your game opening on the stage closes the sheet (it would cover the game).
  const stageId = arcadeStage.value?.lobbyId ?? null;
  const openedWith = useRef(stageId);
  useEffect(() => {
    if (stageId && stageId !== openedWith.current) onClose();
  }, [stageId, onClose]);
  // The lobby went away under the invite list.
  useEffect(() => {
    if (!here && view.kind === 'invite') setView({ kind: 'main' });
  }, [here, view.kind]);
  // A game with save slots: the setup screen opens on the tale one tap would play.
  const slotGame = view.kind === 'setup' && saveSlotField(view.meta, 'online', view.mode) ? view.meta.id : null;
  useEffect(() => {
    if (!slotGame) return;
    let alive = true;
    void listSaves(slotGame).then((answer) => {
      if (!alive) return;
      if (!answer.ok) return setError(refusalText(answer.code));
      setView((v) => {
        if (v.kind !== 'setup' || v.meta.id !== slotGame) return v;
        const field = saveSlotField(v.meta, 'online', v.mode);
        const values = v.picked ? v.values : (withSaveSlot(v.meta, 'online', v, answer.slots) ?? (field ? { ...v.values, [field.key]: 'new' } : v.values));
        return { ...v, slots: answer.slots, values };
      });
    });
    return () => {
      alive = false;
    };
  }, [slotGame]);

  const act = async (id: string, as: JoinAs) => {
    setError(null);
    setError(await joinGame(id, as));
  };
  const back = () => {
    setError(null);
    setView({ kind: 'main' });
  };

  /** A start card: create the lobby with the remembered setup at once (a save-slot game reads its saves first). */
  const quickStart = async (meta: GameMeta) => {
    if (!channelId || starting) return;
    setError(null);
    const setup = resolveSetup(meta, 'online');
    let values = setup.values;
    setStarting(meta.id);
    if (saveSlotField(meta, 'online', setup.mode)) {
      const answer = await listSaves(meta.id);
      const picked = answer.ok ? withSaveSlot(meta, 'online', setup, answer.slots) : null;
      if (!picked) {
        // Nothing safe to continue or start: the setup screen asks.
        setStarting(null);
        if (!answer.ok) setError(refusalText(answer.code));
        else setView({ ...setupView(meta), slots: answer.slots, values: { ...setup.values } });
        return;
      }
      values = picked;
    }
    const failed = await createGame({ ch: channelId, game: meta.id, mode: setup.mode, cfg: cfgFor(meta, 'online', setup.mode, values) });
    setStarting(null);
    setError(failed);
    if (!failed) saveSetup(meta, 'online', setup);
  };

  /** Start on the setup screen. */
  const create = async (v: SetupView) => {
    if (!channelId) return;
    setCreating(true);
    const values = fillNewTale(v.meta, 'online', v, v.slots);
    const failed = await createGame({ ch: channelId, game: v.meta.id, mode: v.mode, cfg: cfgFor(v.meta, 'online', v.mode, values) });
    setCreating(false);
    setError(failed);
    if (failed) return;
    // A tale the host did not pick stays "whatever one tap picks" (the remembered choice is kept).
    const field = saveSlotField(v.meta, 'online', v.mode);
    const remembered = field && !v.picked ? { ...v.values, [field.key]: storedSetup(v.meta, 'online')?.values[field.key] } : v.values;
    saveSetup(v.meta, 'online', { mode: v.mode, values: remembered });
    setView({ kind: 'main' });
  };

  let body: ComponentChildren;
  let footer: ComponentChildren = null;
  if (view.kind === 'main') {
    const shownRows = allRows ? entries : entries.slice(0, ROWS);
    const cards = (
      <ul className="flex flex-col gap-2 px-1 pb-1">
        {online.map((meta) => {
          const setup = resolveSetup(meta, 'online');
          return (
            <li key={meta.id}>
              <GameCard
                meta={meta}
                summary={summaryOf(meta, 'online', setup.mode, setup.values)}
                onPlay={() => void quickStart(meta)}
                onOptions={hasOptions(meta, 'online', setup) ? () => setView(setupView(meta)) : undefined}
                busy={starting === meta.id}
                disabled={starting !== null}
                data={{ 'data-arcade-row': 'start-' + meta.id }}
                className="bg-base/50"
              />
            </li>
          );
        })}
      </ul>
    );
    body = (
      <>
        {here && (
          <>
            <Title>Your game</Title>
            <YourGame lobby={here} onInvite={() => setView({ kind: 'invite' })} onError={setError} />
          </>
        )}
        {(online.length > 0 || entries.length > 0) && (
          <>
            <Title>Play with your call</Title>
            {!inVoice || !channelId ? (
              <p className="px-3 pb-2 text-sm text-text-muted">Join the voice channel to play with the people in it.</p>
            ) : (
              <>
                {shownRows.map((entry) => (
                  <EntryRow key={entry.id} entry={entry} onAct={(id, as) => void act(id, as)} />
                ))}
                {entries.length > ROWS && (
                  <Disclosure open={allRows} label={allRows ? 'Show fewer' : 'Show ' + (entries.length - ROWS) + ' more'} onToggle={() => setAllRows((v) => !v)} testId="rows" />
                )}
                {online.length > 0 &&
                  (here ? (
                    <>
                      <Disclosure open={otherGame} label="Start a different game" onToggle={() => setOtherGame((v) => !v)} testId="start" />
                      {otherGame && cards}
                    </>
                  ) : (
                    cards
                  ))}
              </>
            )}
          </>
        )}
        <div className="pt-1">
          {solo.length === 0 || stageId ? (
            <p className="px-3 py-2 text-sm text-text-muted">{stageId ? 'Leave your call game to play solo.' : 'No games are ready to play solo yet.'}</p>
          ) : (
            <Row
              icon={<Bot size={16} />}
              label="Play solo"
              detail="On this device, against bots. Nothing is sent."
              onSelect={() => {
                onClose();
                openArcade({ mode: 'local' });
              }}
              testId="solo"
            />
          )}
        </div>
      </>
    );
    footer = (
      <div className="flex flex-wrap items-center gap-x-1 px-2">
        {(chipGames || arcadeWallet.value) && <WalletPill compact />}
        <span className="ml-auto flex items-center gap-1">
          {online.length > 0 && (
            <button type="button" className={cn(SHEET_BUTTON, TEXT, 'px-2')} onClick={() => setView({ kind: 'boards' })} data-arcade-row="boards">
              <Trophy size={16} /> Boards
            </button>
          )}
          <button type="button" className={cn(SHEET_BUTTON, TEXT, 'px-2')} onClick={() => setView({ kind: 'prefs' })} data-arcade-row="prefs">
            <SlidersHorizontal size={16} /> Settings
          </button>
        </span>
      </div>
    );
  } else {
    const title = view.kind === 'setup' ? view.meta.name : view.kind === 'invite' ? 'Invite to your game' : view.kind === 'boards' ? 'Boards' : 'Game settings';
    body = (
      <>
        <div className="flex items-center gap-1 px-1">
          <button type="button" className={cn(SHEET_BUTTON, 'min-w-11 px-0 text-text-muted hover:bg-hover hover:text-text-bright')} aria-label="Back" onClick={back} data-arcade-sheet-back>
            <ChevronLeft size={18} />
          </button>
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-text-bright">{title}</p>
        </div>
        {view.kind === 'setup' && (
          <div className="flex flex-col gap-4 px-3 py-2" data-arcade-setup={view.meta.id}>
            <p className="text-sm text-text-muted">{view.meta.tagline}</p>
            <SetupForm
              meta={view.meta}
              where="online"
              mode={view.mode}
              values={view.values}
              slots={view.slots}
              onMode={(mode) => setView((v) => (v.kind === 'setup' ? { ...v, mode, values: { ...defaultOptions(v.meta, mode, 'online'), ...v.values } } : v))}
              onChange={(key, value) =>
                setView((v) => (v.kind === 'setup' ? { ...v, values: { ...v.values, [key]: value }, picked: v.picked || saveSlotField(v.meta, 'online', v.mode)?.key === key } : v))
              }
            />
          </div>
        )}
        {view.kind === 'invite' && here && <InvitePanel lobby={here} />}
        {view.kind === 'boards' && <BoardsPanel games={online} />}
        {view.kind === 'prefs' && <ArcadePrefs />}
      </>
    );
    if (view.kind === 'setup') {
      // A save-slot game starts once its saves are listed, so a new tale never lands on an old one by accident.
      const waiting = Boolean(saveSlotField(view.meta, 'online', view.mode)) && !view.slots;
      footer = (
        <div className="px-3 py-2">
          <Button size="lg" block className="min-h-11" loading={creating} disabled={!channelId || waiting} onClick={() => void create(view)} data-arcade-create>
            Start
          </Button>
        </div>
      );
    }
  }

  const content = (
    <div className={cn('flex flex-col', !touch && 'min-h-0 flex-1')} data-arcade-sheet>
      <div className={cn('flex flex-col py-1', !touch && 'scrollbar-thin min-h-0 flex-1 overflow-y-auto')}>
        {error && (
          <p className="mx-3 my-1 text-sm text-[#fa777c]" role="alert" data-arcade-error>
            {error}
          </p>
        )}
        {body}
      </div>
      {footer && (
        <div className={cn('shrink-0 border-t border-border bg-sidebar', touch && 'sticky bottom-0 z-10')} data-arcade-footer>
          {footer}
        </div>
      )}
    </div>
  );
  if (touch) {
    const sheetTitle = view.kind === 'main' ? 'Arcade' : view.kind === 'setup' ? view.meta.name : view.kind === 'invite' ? 'Invite to your game' : view.kind === 'boards' ? 'Boards' : 'Game settings';
    return (
      <Sheet title={sheetTitle} showTitle={view.kind === 'main'} onClose={onClose}>
        {content}
      </Sheet>
    );
  }
  return (
    <Popover anchor={anchor} onClose={onClose}>
      {content}
    </Popover>
  );
};
