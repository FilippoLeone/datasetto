import { z } from 'zod';
import { AppError } from '../../errors.js';
import { handle, requireUser, type SocketContext } from '../context.js';

/** The subset of MinigameManager (plain JS) the socket layer relies on. */
export interface Minigames {
  startGame(input: { channelId: string; hostId: string; hostName: string; type: string }): unknown;
  joinGame(channelId: string, playerId: string, playerName: string): unknown;
  leaveGame(channelId: string, playerId: string): unknown;
  handleInput(channelId: string, playerId: string, payload: unknown): void;
  endGame(channelId: string, reason?: string): void;
  handleVoiceMemberLeft(channelId: string, playerId: string): void;
  getState(channelId: string): { hostId?: string } | null;
  getLeaderboard(type: string, limit?: number): Promise<unknown[]>;
  shutdown?(): void;
}

const GAME_TYPES = ['slither', 'pacman', 'fighter'] as const;
const startSchema = z.object({ type: z.enum(GAME_TYPES).optional() }).partial().nullable().optional();
const leaderboardSchema = z.object({ type: z.enum(GAME_TYPES) });

export const registerMinigameHandlers = (sctx: SocketContext, minigames: Minigames): void => {
  const { socket } = sctx;
  const ERR = 'voice:game:error';

  const requireVoice = (): string => {
    requireUser(sctx);
    if (!sctx.voiceChannel) throw new AppError('Join a voice channel first', 'NOT_IN_VOICE', 400);
    return sctx.voiceChannel;
  };

  const playerName = () => sctx.user?.displayName ?? 'Player';

  handle(sctx, 'voice:game:start', { schema: startSchema, errorEvent: ERR, code: 'GAME_START_FAILED' }, (payload) => {
    const channelId = requireVoice();
    minigames.startGame({ channelId, hostId: socket.id, hostName: playerName(), type: payload?.type ?? 'slither' });
  });

  handle(sctx, 'voice:game:join', { errorEvent: ERR, code: 'GAME_JOIN_FAILED' }, () => {
    const channelId = requireVoice();
    const state = minigames.joinGame(channelId, socket.id, playerName());
    if (state) socket.emit('voice:game:state', state);
  });

  handle(sctx, 'voice:game:leave', { errorEvent: ERR, code: 'GAME_LEAVE_FAILED' }, () => {
    const channelId = requireVoice();
    const state = minigames.leaveGame(channelId, socket.id);
    if (state) socket.emit('voice:game:state', state);
  });

  handle(sctx, 'voice:game:input', { errorEvent: ERR, code: 'GAME_INPUT_FAILED', limiter: 'game' }, (payload) => {
    const channelId = requireVoice();
    minigames.handleInput(channelId, socket.id, payload ?? {});
  });

  handle(sctx, 'voice:game:end', { errorEvent: ERR, code: 'GAME_END_FAILED' }, () => {
    const channelId = requireVoice();
    const state = minigames.getState(channelId);
    if (!state) throw new AppError('No active minigame to end', 'NO_GAME', 404);
    if (state.hostId !== socket.id && !sctx.user?.isSuperuser) {
      throw new AppError('Only the host can end this minigame', 'FORBIDDEN', 403);
    }
    minigames.endGame(channelId, 'ended_by_host');
  });

  handle(sctx, 'voice:game:leaderboard', { schema: leaderboardSchema, errorEvent: ERR, code: 'LEADERBOARD_FAILED' }, async ({ type }, ack) => {
    const leaderboard = await minigames.getLeaderboard(type);
    if (ack) ack({ success: true, leaderboard });
    else socket.emit('voice:game:leaderboard', { type, leaderboard });
  });
};
