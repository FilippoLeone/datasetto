import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronLeft, Gamepad2, Menu, Minimize2, Play, X } from 'lucide-preact';
import { Button, IconButton, Spinner } from '@/components';
import { pushBackHandler } from '@/lib/backStack';
import { cn } from '@/lib/cn';
import { CATALOG, defaultOptions, metaOf, type GameMeta } from '@/arcade/catalog';
import type { SessionHandle } from '@/arcade/runtime/session';
import {
  arcadeSession,
  arcadeView,
  closeArcade,
  gameEnabled,
  gameHidden,
  openArcade,
} from './state';
import { GameCard } from './GameCard';
import { SetupForm } from './LobbyForm';
import { cfgFor, hasOptions, resolveSetup, saveSetup, summaryOf } from './setup';

/** Games that can start offline here: built, switched on, not hidden by the account. */
export const offlineGames = (): GameMeta[] =>
  CATALOG.filter((meta) => meta.ready.offline && gameEnabled(meta.id) && !gameHidden(meta.id));

const PracticeBadge = () => (
  <span
    className="rounded-sm bg-[#1f8a85] px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-white"
    title="Practice play: results and chips stay on this device"
  >
    PRACTICE
  </span>
);

type Step =
  | { kind: 'pick' }
  | { kind: 'setup'; meta: GameMeta; mode: string; values: Record<string, unknown> }
  | { kind: 'play'; meta: GameMeta; mode: string; values: Record<string, unknown> };

const setupFor = (meta: GameMeta): Step => ({ kind: 'setup', meta, ...resolveSetup(meta, 'offline') });

/**
 * Local play over the whole window (platform.md §10.6, §12): "Play solo" in the Arcade sheet,
 * the Arcade row in the channel list, and "Play offline" on the sign-in screen and the offline banner. It
 * needs no socket, no /api/config and no account. Results and chips stay on this device. A game
 * card plays the remembered setup in one tap; its Options button opens the setup first.
 */
export const ArcadeOverlay = () => {
  const view = arcadeView.value;
  const session = arcadeSession.value;
  const [step, setStep] = useState<Step>(() => {
    const meta = view?.game ? metaOf(view.game) : null;
    return meta && meta.ready.offline ? setupFor(meta) : { kind: 'pick' };
  });
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SessionHandle | null>(null);
  const minimized = Boolean(session?.minimized && session.mode === 'local');

  const stopSession = () => {
    sessionRef.current?.stop();
    sessionRef.current = null;
  };

  const leave = () => {
    stopSession();
    closeArcade();
  };

  // Mount the game once the stage element exists.
  useEffect(() => {
    if (step.kind !== 'play' || !stageRef.current) return;
    let cancelled = false;
    setStarting(true);
    setError(null);
    void import('@/arcade/runtime/session')
      .then(({ startLocalSession }) =>
        startLocalSession({
          meta: step.meta,
          mode: step.mode,
          cfg: cfgFor(step.meta, 'offline', step.mode, step.values),
          el: stageRef.current as HTMLElement,
          onLeave: leave,
          onMinimize: () => undefined,
        })
      )
      .then((handle) => {
        if (cancelled) {
          handle.stop();
          return;
        }
        sessionRef.current = handle;
        saveSetup(step.meta, 'offline', { mode: step.mode, values: step.values });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(
          reason instanceof Error && reason.message ? reason.message : 'The game could not start.'
        );
        // Back to the setup that failed, with the error above Play.
        setStep({ kind: 'setup', meta: step.meta, mode: step.mode, values: step.values });
      })
      .finally(() => {
        if (!cancelled) setStarting(false);
      });
    return () => {
      cancelled = true;
      stopSession();
    };
    // Starting depends on the step identity only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const back = () => {
    if (step.kind === 'play') {
      sessionRef.current?.back();
      return;
    }
    if (step.kind === 'setup' && !view?.game) {
      setError(null);
      setStep({ kind: 'pick' });
      return;
    }
    leave();
  };
  const backRef = useRef(back);
  backRef.current = back;
  const [backGen, setBackGen] = useState(0);
  // Android back: the game's own back first (its pause menu), then minimize; outside a game, a step back.
  // Each press pops our entry, so it is registered again for the next one.
  useEffect(() => {
    if (minimized) return;
    return pushBackHandler(() => {
      backRef.current();
      setBackGen((n) => n + 1);
    });
  }, [minimized, backGen]);
  // Escape outside a running game goes one step back (inside, the game's menu key has it).
  useEffect(() => {
    if (minimized || step.kind === 'play') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      backRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [minimized, step.kind]);

  const minimize = () => {
    const current = arcadeSession.peek();
    if (current) arcadeSession.value = { ...current, minimized: true };
  };
  const chipMeta = session ? metaOf(session.game) : null;
  const chip = minimized && session && (
    <button
      type="button"
      onClick={() => openArcade({ mode: 'local' })}
      className={cn(
        'fixed right-3 bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] z-[60] flex min-h-11 items-center gap-2 rounded-full bg-elevated px-4 text-sm font-semibold text-text-bright shadow-pop',
        session.attention && 'ring-2 ring-warning'
      )}
      data-arcade-chip
    >
      <Gamepad2 size={16} /> {(chipMeta?.name ?? 'Game') + ' running · Return'}
    </button>
  );

  const games = offlineGames();
  const title = step.kind === 'pick' ? 'Arcade' : step.meta.name;

  return (
    <>
      {chip}
      <div
        className={cn(
          'fixed inset-0 z-[60] flex flex-col bg-base safe-top safe-x safe-bottom',
          minimized && 'hidden'
        )}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-arcade-overlay
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
          <IconButton
            label={step.kind === 'pick' ? 'Close' : step.kind === 'play' ? 'Game menu' : 'Back'}
            onClick={back}
          >
            {step.kind === 'pick' ? (
              <X size={18} />
            ) : step.kind === 'play' ? (
              <Menu size={18} />
            ) : (
              <ChevronLeft size={18} />
            )}
          </IconButton>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-bright">
            {title}
          </h2>
          {step.kind !== 'pick' && step.meta.chips && <PracticeBadge />}
          {step.kind === 'play' && (
            <>
              <IconButton label="Minimize" onClick={minimize}>
                <Minimize2 size={18} />
              </IconButton>
              <IconButton label="Leave game" onClick={leave}>
                <X size={18} />
              </IconButton>
            </>
          )}
        </header>

        {step.kind === 'pick' && (
          <div className="scrollbar-thin flex-1 overflow-y-auto p-4">
            <p className="mb-3 text-sm text-text-muted">
              Play on this device. Nothing is sent to the server and results don't count.
            </p>
            {games.length === 0 ? (
              <p className="rounded-md bg-sidebar p-4 text-sm text-text-muted" data-arcade-empty>
                No games are ready to play offline yet.
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {games.map((meta) => {
                  const setup = resolveSetup(meta, 'offline');
                  return (
                    <li key={meta.id} className="min-w-0">
                      <GameCard
                        meta={meta}
                        summary={summaryOf(meta, 'offline', setup.mode, setup.values)}
                        onPlay={() => {
                          setError(null);
                          setStep({ kind: 'play', meta, ...setup });
                        }}
                        onOptions={
                          hasOptions(meta, 'offline', setup)
                            ? () => setStep({ kind: 'setup', meta, ...setup })
                            : undefined
                        }
                        data={{ 'data-arcade-tile': meta.id }}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {step.kind === 'setup' && (
          <div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div className="mx-auto flex w-full max-w-md flex-col gap-5 p-4">
              <p className="text-sm text-text-muted">{step.meta.tagline}</p>
              <SetupForm
                meta={step.meta}
                where="offline"
                mode={step.mode}
                values={step.values}
                onMode={(mode) =>
                  setStep((s) =>
                    s.kind === 'setup'
                      ? { ...s, mode, values: { ...defaultOptions(s.meta, mode, 'offline'), ...s.values } }
                      : s
                  )
                }
                onChange={(key, value) =>
                  setStep((s) =>
                    s.kind === 'setup' ? { ...s, values: { ...s.values, [key]: value } } : s
                  )
                }
              />
            </div>
            <div className="sticky bottom-0 bg-base px-4 pt-2 pb-4">
              <div className="mx-auto flex max-w-md flex-col gap-2">
                {error && (
                  <p className="text-sm text-[#fa777c]" role="alert">
                    {error}
                  </p>
                )}
                <Button
                  size="lg"
                  block
                  onClick={() => {
                    setError(null);
                    setStep({ kind: 'play', meta: step.meta, mode: step.mode, values: step.values });
                  }}
                  data-arcade-start
                >
                  <Play size={18} /> Play
                </Button>
              </div>
            </div>
          </div>
        )}

        {step.kind === 'play' && (
          <div className="relative min-h-0 flex-1">
            <div
              ref={stageRef}
              className="arcade-stage absolute inset-0 flex flex-col"
              data-arcade-stage
            />
            {starting && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Spinner size={28} />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
};

export default ArcadeOverlay;
