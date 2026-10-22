/**
 * Online play from the shell (platform.md §9.2, §10.6): the lobby actions (create, join, watch,
 * leave, accept an invite) and the stage controller. The stage element lives here, not in the
 * voice page, so the game survives the page being closed or the stage minimized: GameStage adopts
 * the element while it shows, and a stage that is not on screen is hidden (`away`) as "Back to
 * call" is. Everything starts from your own click, or from the host starting the lobby you joined.
 */
import { metaOf } from '@/arcade/catalog';
import type { LobbyView } from '@/arcade/runtime/types';
import type { SessionHandle } from '@/arcade/runtime/session';
import { toast } from '@/state/ui';
import { createLobby, joinLobby, leaveLobby, refusalText, type JoinAs } from './api';
import { dismissInvite, enterLobby, forgetLobby, lobbyRole } from './bindings';
import { arcadeLobby, arcadeSession, arcadeStage, type ArcadeInvite } from './state';

interface Running {
  lobbyId: string;
  el: HTMLDivElement;
  handle: SessionHandle | null;
  stopped: boolean;
}

let running: Running | null = null;

/** The element the running game draws into (GameStage moves it into the page while it shows). */
export const stageElement = (): HTMLDivElement | null => running?.el ?? null;

/** Android back / Esc on the stage: the game's own handler first, else minimize. */
export const stageBack = (): void => {
  running?.handle?.back();
};

const errorMessage = (reason: unknown): string => (reason instanceof Error && reason.message ? reason.message : 'The game could not start.');

const halt = (run: Running | null): void => {
  if (running === run) running = null;
  if (!run || run.stopped) return;
  run.stopped = true;
  run.handle?.stop();
  run.el.remove();
};

/** Run the lobby's game on this screen (a no-op when it already runs). */
export const startStage = (lobby: LobbyView, role: JoinAs, ticket?: string): void => {
  if (running?.lobbyId === lobby.id && !running.stopped) return;
  const meta = metaOf(lobby.game);
  if (!meta) return;
  halt(running);
  // One game at a time on this screen: a solo game keeps it until it is closed.
  if (arcadeSession.peek()?.mode === 'local') {
    arcadeStage.value = { lobbyId: lobby.id, ch: lobby.ch, game: lobby.game, role, error: 'Close the game you are playing on your own first.' };
    return;
  }
  const el = document.createElement('div');
  el.className = 'arcade-stage absolute inset-0 flex flex-col';
  el.setAttribute('data-arcade-stage', lobby.id);
  const run: Running = { lobbyId: lobby.id, el, handle: null, stopped: false };
  running = run;
  arcadeStage.value = { lobbyId: lobby.id, ch: lobby.ch, game: lobby.game, role, error: null };
  void import('@/arcade/runtime/session')
    .then(({ startRemoteSession }) =>
      startRemoteSession({ meta, lobby, role, ticket, el, onLeave: () => leaveCurrent(), onMinimize: () => undefined }),
    )
    .then(
      (handle) => {
        if (run.stopped) handle.stop();
        else run.handle = handle;
      },
      (reason: unknown) => {
        if (run.stopped) return;
        halt(run);
        const stage = arcadeStage.peek();
        if (stage?.lobbyId === lobby.id) arcadeStage.value = { ...stage, error: errorMessage(reason) };
      },
    );
};

/** Close the game on this screen (the lobby membership stays). */
export const stopStage = (): void => {
  halt(running);
  if (arcadeStage.peek()) arcadeStage.value = null;
};

/** "Back to call": the stage collapses to a chip; the game counts as hidden until it returns. */
export const minimizeStage = (): void => {
  const session = arcadeSession.peek();
  if (session?.mode === 'remote' && !session.minimized) arcadeSession.value = { ...session, minimized: true };
};

/** Leave the game and the lobby (Leave, hiding the game, leaving the call). */
export const leaveCurrent = (): void => {
  const id = arcadeStage.peek()?.lobbyId ?? arcadeLobby.peek()?.id ?? null;
  stopStage();
  if (!id) return;
  forgetLobby(id);
  void leaveLobby(id);
};

/** The lobby you are in went live (bindings): open the stage, unless a solo game has the screen. */
export const lobbyLive = (lobby: LobbyView): void => {
  if (arcadeSession.peek()?.mode === 'local') return;
  if (arcadeLobby.peek()?.id !== lobby.id) return;
  startStage(lobby, lobbyRole(lobby));
};

/** The lobby you are in closed: a game nobody is looking at goes at once; on screen it stays until Leave. */
export const lobbyEnded = (id: string): void => {
  const stage = arcadeStage.peek();
  if (stage?.lobbyId !== id) return;
  const session = arcadeSession.peek();
  if (stage.error || !session || session.minimized) stopStage();
};

/** Enter a lobby from an ack; a running game opens on this screen at once. */
const entered = (lobby: LobbyView, role: JoinAs, ticket?: string): void => {
  enterLobby(lobby, role);
  if (lobby.st === 'live' && arcadeSession.peek()?.mode !== 'local') startStage(lobby, role, ticket);
};

/** Join a seat or watch (sheet rows, chips). Resolves to an error text, or null on success. */
export const joinGame = async (id: string, as: JoinAs): Promise<string | null> => {
  const answer = await joinLobby(id, as);
  if (!answer.ok) return refusalText(answer.code);
  // Joining another lobby leaves the one you were in.
  const previous = arcadeLobby.peek();
  if (previous && previous.id !== answer.lobby.id) leaveCurrent();
  entered(answer.lobby, as, answer.ticket);
  return null;
};

/** "Start a game": create the lobby with you in the first seat. */
export const createGame = async (o: { ch: string; game: LobbyView['game']; mode: string; cfg: Record<string, unknown> }): Promise<string | null> => {
  const answer = await createLobby(o);
  if (!answer.ok) return refusalText(answer.code);
  const previous = arcadeLobby.peek();
  if (previous && previous.id !== answer.lobby.id) leaveCurrent();
  entered(answer.lobby, 'player', answer.ticket);
  return null;
};

/** A chip's Join / Watch / Open: errors go to a toast, since a chip has no room for them. */
export const joinFromChip = (id: string, as: JoinAs): void => {
  void joinGame(id, as).then((error) => {
    if (error) toast.error(error);
  });
};

export const acceptInvite = (invite: ArcadeInvite): void => {
  dismissInvite(invite.id);
  joinFromChip(invite.id, 'player');
};

/** "Open game" for a live lobby you are in whose stage is not running (after an error, or a solo game). */
export const reopenStage = (): void => {
  const lobby = arcadeLobby.peek();
  if (lobby && lobby.st === 'live') startStage(lobby, lobbyRole(lobby));
};
