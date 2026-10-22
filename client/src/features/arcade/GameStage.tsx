import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { LogOut, Minimize2, RotateCcw } from 'lucide-preact';
import { Spinner } from '@/components';
import { pushBackHandler } from '@/lib/backStack';
import { metaOf } from '@/arcade/catalog';
import type { SessionStatus } from '@/arcade/runtime/types';
import { leaveCurrent, minimizeStage, reopenStage, stageBack, stageElement, stopStage } from './remote';
import { arcadeSession, arcadeStage } from './state';
import { VoiceStrip } from './VoiceStrip';

const STATUS: Record<SessionStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  lagging: 'Slow connection',
  paused: 'Paused',
  away: 'Away',
  ended: 'Game over',
};

/** Stage header buttons: ≥ 44 px, text beside the icon from the sm breakpoint. */
export const STAGE_BUTTON = 'flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium text-text hover:bg-hover hover:text-text-bright active:bg-active';

/**
 * The online stage (platform.md §10.6): replaces the video grid in the voice page on your own
 * screen while you play or watch there. The game draws into the element the stage controller owns
 * (remote.ts), moved in here while the stage shows; leaving the page or "Back to call" minimizes it
 * (the game is then hidden, `away`), and Leave closes it and releases the seat.
 */
export const GameStage = () => {
  const stage = arcadeStage.value;
  const session = arcadeSession.value;
  const slot = useRef<HTMLDivElement>(null);
  const live = stage && session?.mode === 'remote' && session.id === stage.lobbyId ? session : null;

  // Adopt the running game's element; when the stage stops showing, the game is minimized.
  useLayoutEffect(() => {
    const el = stageElement();
    const host = slot.current;
    if (!el || !host) return;
    host.appendChild(el);
    return () => {
      if (el.parentNode !== host) return;
      el.remove();
      minimizeStage();
    };
  }, [stage]);

  // Android back: the game's own back first (its pause menu), then minimize. Each press pops our entry.
  const [backGen, setBackGen] = useState(0);
  const running = live !== null;
  useEffect(() => {
    if (!running) return;
    return pushBackHandler(() => {
      stageBack();
      setBackGen((n) => n + 1);
    });
  }, [running, backGen]);

  if (!stage) return null;
  const name = metaOf(stage.game)?.name ?? 'Game';
  const status = stage.error ? 'Could not start' : live ? STATUS[live.status] : STATUS.connecting;
  const back = () => (live ? minimizeStage() : stopStage());

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={name} data-arcade-game-stage={stage.lobbyId}>
      <VoiceStrip />
      <header className="flex shrink-0 flex-wrap items-center gap-1 border-y border-border bg-sidebar px-2 py-1" data-arcade-stage-header>
        <span className="min-w-0 flex-1 px-1">
          <span className="block truncate text-sm font-semibold text-text-bright">{name}</span>
          <span className="block truncate text-xs text-text-muted" data-arcade-status>
            {(stage.role === 'spectator' ? 'Watching · ' : '') + status}
          </span>
        </span>
        <button type="button" className={STAGE_BUTTON} onClick={back} title="Back to call" data-arcade-back>
          <Minimize2 size={16} /> <span className="max-sm:sr-only">Back to call</span>
        </button>
        <button type="button" className={STAGE_BUTTON} onClick={leaveCurrent} title="Leave game" data-arcade-leave>
          <LogOut size={16} /> <span className="max-sm:sr-only">Leave</span>
        </button>
        {live?.yielding && (
          <p className="w-full px-1 pb-0.5 text-xs text-[#ffd38a]" role="status" data-arcade-yield>
            Paused so chat and voice can catch up
          </p>
        )}
      </header>
      <div className="relative min-h-0 flex-1 bg-base">
        <div ref={slot} className="absolute inset-0" />
        {stage.error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
            <p className="text-sm text-[#fa777c]" role="alert">
              {stage.error}
            </p>
            <button type="button" className={STAGE_BUTTON + ' bg-active px-4'} onClick={reopenStage}>
              <RotateCcw size={16} /> Try again
            </button>
          </div>
        ) : (
          (!live || live.status === 'connecting') && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Spinner size={28} />
            </div>
          )
        )}
      </div>
    </section>
  );
};
