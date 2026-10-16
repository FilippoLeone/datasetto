import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Gamepad2, Trophy, X } from 'lucide-preact';
import { Button, IconButton } from '@/components';
import { cn } from '@/lib/cn';
import { api } from '@/services/socket/api';
import { minigameState } from '@/state/misc';
import { socketId } from '@/state/session';
import { isMobile } from '@/state/ui';
import type { Direction, MinigameEngine } from './engine';
import type { Channel, LeaderboardEntry, MinigameType, VoiceMinigameState } from '@/types/protocol';

const GAMES: Array<{ type: MinigameType; label: string; blurb: string }> = [
  { type: 'slither', label: 'Slither', blurb: 'Grow by eating pellets, avoid the other snakes. Mouse or WASD.' },
  { type: 'pacman', label: 'Pacman', blurb: 'Race for pellets in a maze. Arrow keys or WASD.' },
  { type: 'fighter', label: 'Fighter', blurb: 'Side-view brawl. A/D move, W jump, J punch, K kick, L block.' },
];

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable));
};

const Scoreboard = ({ state }: { state: VoiceMinigameState }) => {
  const me = socketId.value;
  const rows = state.leaderboard?.length ? state.leaderboard : state.players.map((player) => ({ id: player.id, name: player.name, score: player.score }));
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {rows.slice(0, 6).map((row, index) => (
        <li key={row.id} className={cn('flex items-center gap-1', row.id === me ? 'text-text-bright' : 'text-text-muted')}>
          <span className="text-text-faint">{index + 1}.</span> {row.name} <span className="font-semibold tabular-nums">{row.score}</span>
        </li>
      ))}
    </ol>
  );
};

const DPad = ({ engine }: { engine: MinigameEngine | null }) => {
  const press = (direction: Direction, pressed: boolean) => engine?.setDirection(direction, pressed);
  const Btn = ({ direction, icon }: { direction: Direction; icon: preact.ComponentChildren }) => (
    <button
      type="button"
      aria-label={direction}
      className="flex h-12 w-12 items-center justify-center rounded-md bg-elevated text-text-bright active:bg-brand"
      onPointerDown={(event) => {
        event.preventDefault();
        press(direction, true);
      }}
      onPointerUp={() => press(direction, false)}
      onPointerLeave={() => press(direction, false)}
      onPointerCancel={() => press(direction, false)}
    >
      {icon}
    </button>
  );
  return (
    <div className="grid grid-cols-3 gap-1">
      <span />
      <Btn direction="up" icon={<ArrowUp size={20} />} />
      <span />
      <Btn direction="left" icon={<ArrowLeft size={20} />} />
      <span />
      <Btn direction="right" icon={<ArrowRight size={20} />} />
      <span />
      <Btn direction="down" icon={<ArrowDown size={20} />} />
      <span />
    </div>
  );
};

export const MinigamePanel = ({ channel, onClose }: { channel: Channel; onClose: () => void }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<MinigameEngine | null>(null);
  const [engine, setEngine] = useState<MinigameEngine | null>(null);
  const [leaderboard, setLeaderboard] = useState<{ type: MinigameType; entries: LeaderboardEntry[] } | null>(null);
  const state = minigameState.value;
  const active = state && state.channelId === channel.id && state.status === 'running' ? state : null;
  const me = socketId.value;
  const isHost = active?.hostId === me;
  const playing = Boolean(active && me && active.players.some((player) => player.id === me));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let instance: MinigameEngine | null = null;
    const cleanups: Array<() => void> = [];
    // The engine is code-split: it is only needed while a game is open.
    void import('./engine').then(({ MinigameEngine: Engine }) => {
      if (disposed) return;
      instance = new Engine(canvas, {
        getLocalPlayerId: () => socketId.value,
        sendInput: (payload: unknown) => api.sendGameInput(payload),
      });
      engineRef.current = instance;
      setEngine(instance);
      instance.resize();
      instance.start();
      instance.setState(minigameState.value);
      const onResize = () => instance?.resize();
      const onKeyDown = (event: KeyboardEvent) => {
        if (isTyping(event.target)) return;
        if (instance?.handleKeyDown(event)) event.preventDefault();
      };
      const onKeyUp = (event: KeyboardEvent) => {
        if (instance?.handleKeyUp(event)) event.preventDefault();
      };
      window.addEventListener('resize', onResize);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      cleanups.push(() => {
        window.removeEventListener('resize', onResize);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
      });
    });
    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
      instance?.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setState(active);
  }, [active]);

  const showLeaderboard = async (type: MinigameType) => {
    try {
      const result = await api.leaderboard(type);
      setLeaderboard({ type, entries: result.leaderboard ?? [] });
    } catch {
      setLeaderboard({ type, entries: [] });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 py-2 text-sm">
        <Gamepad2 size={16} className="text-warning" />
        <span className="font-semibold text-text-bright">{active ? GAMES.find((game) => game.type === active.type)?.label : 'Minigames'}</span>
        {active && <span className="text-xs text-text-muted">hosted by {active.hostName}</span>}
        <span className="flex-1" />
        {active && !playing && (
          <Button size="sm" variant="success" onClick={() => api.joinGame()}>
            Join game
          </Button>
        )}
        {active && playing && (
          <Button size="sm" variant="secondary" onClick={() => api.leaveGame()}>
            Leave game
          </Button>
        )}
        {active && isHost && (
          <Button size="sm" variant="danger" onClick={() => api.endGame()}>
            End game
          </Button>
        )}
        <IconButton label="Close minigames" size="sm" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>

      {!active && (
        <div className="grid gap-2 px-4 pb-2 sm:grid-cols-3">
          {GAMES.map((game) => (
            <div key={game.type} className="flex flex-col gap-2 rounded-md bg-sidebar p-3">
              <p className="font-semibold text-text-bright">{game.label}</p>
              <p className="flex-1 text-xs text-text-muted">{game.blurb}</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => api.startGame(game.type)}>
                  Start
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void showLeaderboard(game.type)}>
                  <Trophy size={14} /> Top scores
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {leaderboard && !active && (
        <div className="mx-4 mb-2 rounded-md bg-base/60 p-3 text-sm">
          <p className="mb-1 font-semibold text-text-bright">Top scores · {GAMES.find((game) => game.type === leaderboard.type)?.label}</p>
          {leaderboard.entries.length === 0 ? (
            <p className="text-text-muted">No scores yet.</p>
          ) : (
            <ol className="list-decimal pl-5 text-text-muted">
              {leaderboard.entries.map((entry) => (
                <li key={entry.name}>
                  {entry.name} <span className="font-semibold text-text-bright tabular-nums">{entry.score}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div className={cn('relative min-h-0 flex-1 px-4 pb-2', !active && 'hidden sm:block')}>
        <canvas ref={canvasRef} className="h-full w-full rounded-md bg-[#0b0c10]" />
        {active && (
          <div className="absolute top-2 left-6 rounded-sm bg-black/60 px-2 py-1">
            <Scoreboard state={active} />
          </div>
        )}
      </div>

      {active && playing && isMobile.value && (
        <div className="flex items-center justify-between px-4 pb-3">
          <DPad engine={engine} />
          {active.type === 'fighter' && (
            <div className="flex gap-2">
              {(['punch', 'kick', 'block'] as const).map((action) => (
                <button
                  key={action}
                  type="button"
                  className="h-12 rounded-md bg-elevated px-3 text-sm font-semibold text-text-bright active:bg-brand"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    engine?.pressAction(action, true);
                  }}
                  onPointerUp={() => engine?.pressAction(action, false)}
                  onPointerLeave={() => engine?.pressAction(action, false)}
                >
                  {action}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
