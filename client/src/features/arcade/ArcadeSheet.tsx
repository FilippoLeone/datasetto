import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Bot, ChevronLeft, Minus, Plus, SlidersHorizontal, Trophy, UserPlus } from 'lucide-preact';
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
import { GameIcon, offlineGames } from './ArcadeOverlay';
import { forgetLobby } from './bindings';
import { BoardsPanel } from './BoardsPanel';
import { activitySummary } from './LobbyChip';
import { LobbyForm } from './LobbyForm';
import { createGame, joinGame, leaveCurrent, reopenStage } from './remote';
import { arcadeActivity, arcadeLobby, arcadeStage, arcadeWallet, gameEnabled, gameHidden, openArcade, type ActivityEntry } from './state';
import { WalletPill } from './WalletPill';

/** One line of the channel's activity: "Fuseyard · 2/4 · playing". */
export const activityLabel = (entry: ActivityEntry): string =>
  activitySummary(entry) + ' · ' + (entry.st === 'live' ? 'playing' : entry.st === 'dash' ? 'Glimmer Dash' : entry.st === 'open' ? 'open' : 'setting up');

/** Games that can be started online here: built for it, switched on, not hidden by the account. */
export const onlineGames = (): GameMeta[] => CATALOG.filter((meta) => meta.ready.online && meta.modes.some((m) => m.online) && gameEnabled(meta.id) && !gameHidden(meta.id));

/** Sheet buttons and rows: ≥ 44 px touch targets. */
const SHEET_BUTTON = 'flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors disabled:opacity-50';

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
      className="scrollbar-thin fixed z-[70] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg bg-sidebar p-1 shadow-modal animate-pop"
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

const accountNames = (): Map<string, string> => new Map(users.value.map((user) => [user.accountId, user.displayName]));

/** One of this channel's games you are not in: Join seat / Watch / Open. */
const EntryRow = ({ entry, onAct }: { entry: ActivityEntry; onAct(id: string, as: JoinAs): void }) => {
  const meta = metaOf(entry.g);
  // A Glimmerhall hall stays open while a Glimmer Dash runs inside it: only the Dash can't be joined.
  const join = entry.n < entry.max;
  return (
    <div className="flex min-h-12 items-center gap-2 rounded-md px-3" data-arcade-row={'activity-' + entry.id}>
      <span className="flex w-5 shrink-0 justify-center text-text-muted">{meta && <GameIcon icon={meta.icon} size={16} />}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text-bright">{activitySummary(entry)}</span>
        <span className="block truncate text-xs text-text-muted">{(entry.st === 'live' ? 'Playing' : entry.st === 'dash' ? 'Glimmer Dash' : entry.st === 'open' ? 'Open' : 'Setting up') + (entry.w > 0 ? ' · ' + entry.w + ' watching' : '')}</span>
      </span>
      {join && (
        <button type="button" className={cn(SHEET_BUTTON, 'bg-brand text-white hover:bg-brand-hover')} onClick={() => onAct(entry.id, 'player')} data-arcade-join={entry.id}>
          {entry.st === 'open' || entry.st === 'dash' ? 'Open' : 'Join seat'}
        </button>
      )}
      {meta?.watch && (
        <button type="button" className={cn(SHEET_BUTTON, 'bg-active text-text-bright hover:bg-hover')} onClick={() => onAct(entry.id, 'spectator')} data-arcade-watch={entry.id}>
          Watch
        </button>
      )}
    </div>
  );
};

/** The lobby you are in: seats, the host's bots, options and Start, Invite and Leave. */
const LobbyPanel = ({ lobby, onInvite, onError }: { lobby: LobbyView; onInvite(): void; onError(text: string | null): void }) => {
  const meta = metaOf(lobby.game);
  const me = account.value?.id ?? null;
  const isHost = lobby.host === me;
  const names = accountNames();
  const stage = arcadeStage.value;
  const [bots, setBots] = useState(0);
  const [busy, setBusy] = useState(false);
  const humans = lobby.seats.filter((seat) => seat.a).length;
  const hostBots = meta?.hostBots !== false;
  const botCount = hostBots ? Math.min(bots, lobby.seats.length - humans) : 0;
  const forming = lobby.st === 'open';
  const cfg = (lobby.cfg && typeof lobby.cfg === 'object' ? lobby.cfg : {}) as Record<string, unknown>;
  const options = meta ? meta.options.filter((field) => field.kind !== 'saveSlot') : [];

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

  return (
    <section className="mx-1 mb-1 rounded-md bg-base/60 p-2" data-arcade-lobby={lobby.id}>
      <p className="truncate px-1 text-sm font-semibold text-text-bright">
        {(meta?.name ?? lobby.game) + ' · ' + (meta?.modes.find((m) => m.id === lobby.mode)?.label ?? lobby.mode)}
      </p>
      <p className="px-1 text-xs text-text-muted">
        {(lobby.st === 'live' ? 'Playing' : isHost ? 'You are the host' : 'Waiting for the host to start') + (lobby.spec > 0 ? ' · ' + lobby.spec + ' watching' : '')}
      </p>
      <ol className="flex flex-col py-1">
        {lobby.seats.map((seat, i) => (
          <li key={i} className="flex min-h-8 items-center gap-2 px-1 text-sm" data-arcade-seat={i}>
            <span className="w-5 shrink-0 text-right text-xs text-text-muted tabular-nums">{i + 1}</span>
            <span className={cn('min-w-0 flex-1 truncate', seat.a ? 'text-text-bright' : 'text-text-muted')}>
              {seat.a ? (names.get(seat.a) ?? 'Player') + (seat.a === me ? ' (you)' : '') : seat.bot ? 'Bot' : forming && i < humans + botCount ? 'Bot' : 'Open seat'}
            </span>
            {seat.a && seat.a === lobby.host && <span className="text-[11px] text-text-faint">host</span>}
            {seat.st === 1 && <span className="text-[11px] text-warning">reconnecting</span>}
          </li>
        ))}
      </ol>
      {isHost && forming && hostBots && (
        <div className="flex items-center gap-1 px-1 text-sm">
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
      {isHost && forming && meta && options.length > 0 && (
        <div className="px-1 py-2">
          <LobbyForm
            meta={{ ...meta, modes: meta.modes.filter((m) => m.id === lobby.mode), options }}
            where="online"
            mode={lobby.mode}
            values={cfg}
            onMode={() => undefined}
            onChange={(key, value) => void run(() => setLobbyConfig(lobby.id, { ...cfg, [key]: value }))}
          />
        </div>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {lobby.st === 'live' && stage?.lobbyId !== lobby.id && (
          <button type="button" className={cn(SHEET_BUTTON, 'bg-brand text-white hover:bg-brand-hover')} onClick={reopenStage} data-arcade-open-game>
            Open game
          </button>
        )}
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
        <button type="button" className={cn(SHEET_BUTTON, 'bg-active text-text-bright hover:bg-hover')} onClick={onInvite} data-arcade-invite-open>
          <UserPlus size={16} /> Invite
        </button>
        <button type="button" className={cn(SHEET_BUTTON, 'text-text hover:bg-hover')} onClick={leaveCurrent} data-arcade-leave-lobby>
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
            <button type="button" className={cn(SHEET_BUTTON, 'bg-active text-text-bright hover:bg-hover')} onClick={() => void invite(user.accountId)} data-arcade-invite-to={user.accountId}>
              Invite
            </button>
          )}
        </li>
      ))}
    </ul>
  );
};

interface Setup {
  meta: GameMeta;
  mode: string;
  values: Record<string, unknown>;
}

const setupFor = (meta: GameMeta): Setup => {
  const mode = meta.modes.find((m) => m.online)?.id ?? meta.modes[0]?.id ?? '';
  return { meta, mode, values: defaultOptions(meta, mode) };
};

/** "Start a game": the game's options (save slots from `arcade:saves`), then the lobby. */
const SetupPanel = ({ setup, channelId, onChange, onDone, onError }: { setup: Setup; channelId: string; onChange(next: Setup): void; onDone(): void; onError(text: string | null): void }) => {
  const [slots, setSlots] = useState<{ slot: number; label: string }[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const game = setup.meta.id;
  const needsSlots = setup.meta.options.some((field) => field.kind === 'saveSlot');
  useEffect(() => {
    if (!needsSlots) return;
    let alive = true;
    void listSaves(game).then((answer) => {
      if (alive && answer.ok)
        setSlots(answer.slots.map((s) => ({ slot: s.slot, label: 'Slot ' + (s.slot + 1) + ' · ' + new Date(s.updatedAt).toLocaleDateString() + (s.inUse ? ' (in use)' : '') })));
    });
    return () => {
      alive = false;
    };
  }, [game, needsSlots]);
  const create = async () => {
    setBusy(true);
    const error = await createGame({ ch: channelId, game, mode: setup.mode, cfg: setup.values });
    setBusy(false);
    onError(error);
    if (!error) onDone();
  };
  return (
    <div className="flex flex-col gap-4 px-3 py-2" data-arcade-setup={game}>
      <p className="text-sm text-text-muted">{setup.meta.tagline}</p>
      <LobbyForm
        meta={setup.meta}
        where="online"
        mode={setup.mode}
        values={setup.values}
        slots={slots}
        onMode={(mode) => onChange({ ...setup, mode, values: { ...defaultOptions(setup.meta, mode), ...setup.values } })}
        onChange={(key, value) => onChange({ ...setup, values: { ...setup.values, [key]: value } })}
      />
      <Button size="lg" className="min-h-11" loading={busy} onClick={() => void create()} data-arcade-create>
        Create lobby
      </Button>
    </div>
  );
};

type View = { kind: 'main' } | { kind: 'setup'; setup: Setup } | { kind: 'invite' } | { kind: 'boards' } | { kind: 'prefs' };

/**
 * The Arcade sheet (platform.md §9.2, §10.6): a bottom sheet on touch screens, a popover elsewhere.
 * It lists the lobby you are in, this channel's games (Join seat, Watch, Open), "Start a game",
 * "Solo vs bots", the wallet with the daily claim, the boards and this device's game settings.
 * Opening it changes nothing for anyone else.
 */
export const ArcadeSheet = ({ channelId, anchor, onClose }: { channelId: string | null; anchor: HTMLElement | null; onClose(): void }) => {
  const [view, setView] = useState<View>({ kind: 'main' });
  const [error, setError] = useState<string | null>(null);
  const lobby = arcadeLobby.value;
  const here = lobby && channelId && lobby.ch === channelId ? lobby : null;
  const entries = (channelId ? (arcadeActivity.value.get(channelId) ?? []) : []).filter((entry) => entry.id !== here?.id && !gameHidden(entry.g) && gameEnabled(entry.g));
  const online = onlineGames();
  const inVoice = channelId !== null && voiceChannelId.value === channelId && voiceStatus.value !== 'idle';
  const solo = offlineGames();
  const chipGames = online.some((meta) => meta.id === 'lamplight' || meta.id === 'glimmer');

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

  const act = async (id: string, as: JoinAs) => {
    setError(null);
    setError(await joinGame(id, as));
  };
  const back = () => {
    setError(null);
    setView({ kind: 'main' });
  };

  let body: ComponentChildren;
  if (view.kind === 'main') {
    body = (
      <>
        {here && <LobbyPanel lobby={here} onInvite={() => setView({ kind: 'invite' })} onError={setError} />}
        {entries.length > 0 && (
          <>
            <Title>In this channel</Title>
            {entries.map((entry) => (
              <EntryRow key={entry.id} entry={entry} onAct={(id, as) => void act(id, as)} />
            ))}
          </>
        )}
        {online.length > 0 && (
          <>
            <Title>Start a game</Title>
            {inVoice && channelId ? (
              online.map((meta) => <Row key={meta.id} icon={<GameIcon icon={meta.icon} size={16} />} label={meta.name} detail={meta.tagline} onSelect={() => setView({ kind: 'setup', setup: setupFor(meta) })} testId={'start-' + meta.id} />)
            ) : (
              <p className="px-3 pb-2 text-sm text-text-muted">Join the voice channel to start a game here.</p>
            )}
          </>
        )}
        <Title>Solo vs bots</Title>
        {solo.length === 0 || stageId ? (
          <p className="px-3 pb-2 text-sm text-text-muted">{stageId ? 'Leave your online game to play on your own.' : 'No games are ready yet.'}</p>
        ) : (
          <Row
            icon={<Bot size={16} />}
            label="Play on this device"
            detail="Practice chips; nothing is sent to the server"
            onSelect={() => {
              onClose();
              openArcade({ mode: 'local' });
            }}
            testId="solo"
          />
        )}
        {(chipGames || arcadeWallet.value) && <WalletPill />}
        {online.length > 0 && <Row icon={<Trophy size={16} />} label="Boards" detail="Who leads in each game" onSelect={() => setView({ kind: 'boards' })} testId="boards" />}
        <Row icon={<SlidersHorizontal size={16} />} label="Game settings" detail="Volume, music and touch controls on this device" onSelect={() => setView({ kind: 'prefs' })} testId="prefs" />
      </>
    );
  } else {
    const title = view.kind === 'setup' ? view.setup.meta.name : view.kind === 'invite' ? 'Invite to your game' : view.kind === 'boards' ? 'Boards' : 'Game settings';
    body = (
      <>
        <div className="flex items-center gap-1 px-1">
          <button type="button" className={cn(SHEET_BUTTON, 'min-w-11 px-0 text-text-muted hover:bg-hover hover:text-text-bright')} aria-label="Back" onClick={back} data-arcade-sheet-back>
            <ChevronLeft size={18} />
          </button>
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-text-bright">{title}</p>
        </div>
        {view.kind === 'setup' && channelId && (
          <SetupPanel setup={view.setup} channelId={channelId} onChange={(setup) => setView({ kind: 'setup', setup })} onDone={() => setView({ kind: 'main' })} onError={setError} />
        )}
        {view.kind === 'invite' && here && <InvitePanel lobby={here} />}
        {view.kind === 'boards' && <BoardsPanel games={online} />}
        {view.kind === 'prefs' && <ArcadePrefs />}
      </>
    );
  }

  const content = (
    <div className="flex flex-col py-1" data-arcade-sheet>
      {error && (
        <p className="mx-3 my-1 text-sm text-[#fa777c]" role="alert" data-arcade-error>
          {error}
        </p>
      )}
      {body}
    </div>
  );
  if (isTouchPrimary()) {
    return (
      <Sheet title="Arcade" onClose={onClose}>
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
