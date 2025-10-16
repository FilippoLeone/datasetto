/**
 * Minigame Manager
 * Orchestrates lightweight voice-channel minigames (initially Snake)
 */
import { generateId } from '../utils/helpers.js';
import logger from '../utils/logger.js';

const DIRECTIONS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE_DIRECTION = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

const COLOR_PALETTE = [
  '#ff6b6b',
  '#48dbfb',
  '#1dd1a1',
  '#feca57',
  '#5f27cd',
  '#ff9ff3',
  '#54a0ff',
  '#00d2d3',
];

export default class MinigameManager {
  constructor({ io, channelManager, onChannelUpdate }) {
    this.io = io;
    this.channelManager = channelManager;
    this.onChannelUpdate = typeof onChannelUpdate === 'function' ? onChannelUpdate : null;
    this.sessions = new Map(); // channelId -> session
  }

  /**
   * Start a new game session in the given voice channel
   */
  startGame({ channelId, hostId, hostName, type = 'snake' }) {
    if (!channelId) {
      throw new Error('Channel is required to start a minigame');
    }

    const existing = this.sessions.get(channelId);
    if (existing && existing.status === 'running') {
      throw new Error('A minigame is already running in this channel');
    }

    if (type !== 'snake') {
      throw new Error('Unsupported minigame type');
    }

    const session = {
      id: `mg-${generateId(12)}`,
      type,
      channelId,
      status: 'running',
      hostId,
      hostName,
      createdAt: Date.now(),
      startedAt: Date.now(),
      updatedAt: Date.now(),
      board: { width: 20, height: 20 },
      tickIntervalMs: 220,
      sequence: 0,
      food: null,
      players: new Map(),
      spectators: new Set(),
      intervalHandle: null,
      lastAliveCount: 0,
    };

    this.sessions.set(channelId, session);
    this.channelManager.setChannelMinigame(channelId, {
      gameId: session.id,
      type: session.type,
      status: session.status,
      startedAt: session.startedAt,
      hostId,
      hostName,
    });

    try {
      this.spawnFood(session);
      this.ensurePlayer(session, hostId, hostName);
    } catch (error) {
      this.sessions.delete(channelId);
      this.channelManager.clearChannelMinigame(channelId);
      this.notifyChannelUpdate();
      throw error;
    }

    this.scheduleTick(session);
    this.notifyChannelUpdate();

    const state = this.serialize(session);
    this.io.to(channelId).emit('voice:game:started', state);
    logger.info('Minigame started', { channelId, gameId: session.id, type });
    return state;
  }

  /**
   * Player joins the current minigame session
   */
  joinGame(channelId, playerId, playerName) {
    const session = this.sessions.get(channelId);
    if (!session || session.status !== 'running') {
      throw new Error('No active minigame in this channel');
    }

    this.ensurePlayer(session, playerId, playerName);
    const state = this.serialize(session);
    this.io.to(channelId).emit('voice:game:update', state);
    logger.debug('Minigame player joined', { channelId, gameId: session.id, playerId });
    return state;
  }

  /**
   * Player leaves the current minigame session
   */
  leaveGame(channelId, playerId) {
    const session = this.sessions.get(channelId);
    if (!session) {
      return null;
    }

    const removed = session.players.delete(playerId);
    session.spectators.add(playerId);

    if (!removed) {
      return this.serialize(session);
    }

    if (session.hostId === playerId) {
      const [nextHost] = Array.from(session.players.values());
      if (nextHost) {
        session.hostId = nextHost.id;
        session.hostName = nextHost.name;
        this.channelManager.setChannelMinigame(channelId, {
          gameId: session.id,
          type: session.type,
          status: session.status,
          startedAt: session.startedAt,
          hostId: session.hostId,
          hostName: session.hostName,
        });
        this.notifyChannelUpdate();
      }
    }

    const aliveCount = this.countAlivePlayers(session);
    if (aliveCount === 0) {
      return this.endGame(channelId, 'all_players_left');
    }

    const state = this.serialize(session);
    this.io.to(channelId).emit('voice:game:update', state);
    logger.debug('Minigame player left', { channelId, gameId: session.id, playerId });
    return state;
  }

  /**
   * Handle queued direction input from a player
   */
  handleInput(channelId, playerId, direction) {
    const session = this.sessions.get(channelId);
    if (!session || session.status !== 'running') {
      throw new Error('No active minigame in this channel');
    }

    if (!DIRECTIONS[direction]) {
      throw new Error('Invalid direction');
    }

    const player = session.players.get(playerId);
    if (!player || !player.alive) {
      throw new Error('Player is not part of this game');
    }

    if (direction === player.direction || OPPOSITE_DIRECTION[direction] === player.direction) {
      return;
    }

    player.pendingDirection = direction;
    player.lastInputAt = Date.now();
  }

  /**
   * Host or server requested game termination
   */
  endGame(channelId, reason = 'ended_by_host') {
    const session = this.sessions.get(channelId);
    if (!session) {
      return null;
    }

    if (session.intervalHandle) {
      clearInterval(session.intervalHandle);
      session.intervalHandle = null;
    }

    session.status = 'ended';
    session.endedAt = Date.now();
    session.updatedAt = session.endedAt;
    session.reason = reason;

    const state = this.serialize(session);
    this.channelManager.clearChannelMinigame(channelId);
    this.sessions.delete(channelId);

    this.io.to(channelId).emit('voice:game:ended', { reason, state });
    logger.info('Minigame ended', { channelId, gameId: session.id, reason });
    this.notifyChannelUpdate();
    return state;
  }

  /**
   * Remove player when their voice connection closes
   */
  handleVoiceMemberLeft(channelId, playerId) {
    const session = this.sessions.get(channelId);
    if (!session) {
      return;
    }

    if (!session.players.has(playerId)) {
      return;
    }

    this.leaveGame(channelId, playerId);
  }

  /**
   * Get serialized state snapshot for consumers
   */
  getState(channelId) {
    const session = this.sessions.get(channelId);
    if (!session) {
      return null;
    }
    return this.serialize(session);
  }

  /**
   * Schedule the main game loop for the session
   */
  scheduleTick(session) {
    if (session.intervalHandle) {
      clearInterval(session.intervalHandle);
    }

    const tick = () => {
      try {
        this.tick(session);
      } catch (error) {
        logger.error('Minigame tick error', {
          channelId: session.channelId,
          gameId: session.id,
          error: error?.message,
        });
        this.endGame(session.channelId, 'error');
      }
    };

    session.intervalHandle = setInterval(tick, session.tickIntervalMs);
    session.intervalHandle.unref?.();
  }

  /**
   * Advance game state by one tick
   */
  tick(session) {
    if (session.status !== 'running') {
      return;
    }

    session.sequence += 1;
    session.updatedAt = Date.now();

    const moves = [];
    const occupied = new Map();

    for (const player of session.players.values()) {
      if (!player.alive) {
        continue;
      }

      player.body.forEach((segment, index) => {
        occupied.set(this.cellKey(segment), { playerId: player.id, segmentIndex: index });
      });
    }

    for (const player of session.players.values()) {
      if (!player.alive) {
        continue;
      }

      if (player.pendingDirection && player.pendingDirection !== OPPOSITE_DIRECTION[player.direction]) {
        player.direction = player.pendingDirection;
      }

      const delta = DIRECTIONS[player.direction] || DIRECTIONS.right;
      const head = player.body[0];
      const newHead = { x: head.x + delta.x, y: head.y + delta.y };
      const tail = player.body[player.body.length - 1];
      const willEatFood = session.food && newHead.x === session.food.x && newHead.y === session.food.y;

      if (!willEatFood) {
        occupied.delete(this.cellKey(tail));
      }

      moves.push({
        player,
        newHead,
        newHeadKey: this.cellKey(newHead),
        willEatFood,
        collision: false,
      });
    }

    const headCounts = new Map();

    for (const move of moves) {
      if (this.isOutOfBounds(session, move.newHead)) {
        move.collision = true;
        continue;
      }

      const occupant = occupied.get(move.newHeadKey);
      if (occupant) {
        if (occupant.playerId !== move.player.id) {
          move.collision = true;
          continue;
        }

        if (occupant.segmentIndex > 0) {
          move.collision = true;
          continue;
        }
      }

      headCounts.set(move.newHeadKey, (headCounts.get(move.newHeadKey) || 0) + 1);
    }

    for (const move of moves) {
      if (move.collision) {
        move.player.alive = false;
        continue;
      }

      const headCount = headCounts.get(move.newHeadKey);
      if (headCount && headCount > 1) {
        move.player.alive = false;
        continue;
      }

      move.player.body.unshift(move.newHead);
      if (move.willEatFood) {
        move.player.score += 1;
        this.spawnFood(session);
      } else {
        move.player.body.pop();
      }

      move.player.pendingDirection = null;
    }

    const aliveCount = this.countAlivePlayers(session);
    session.lastAliveCount = aliveCount;

    if (aliveCount === 0) {
      this.endGame(session.channelId, 'everyone_crashed');
      return;
    }

    if (aliveCount === 1 && session.players.size > 1) {
      this.endGame(session.channelId, 'winner');
      return;
    }

    const state = this.serialize(session);
    this.io.to(session.channelId).emit('voice:game:update', state);
  }

  /**
   * Ensure a player entity exists inside the session
   */
  ensurePlayer(session, playerId, playerName) {
    let player = session.players.get(playerId);
    if (player && player.alive) {
      player.name = playerName;
      return player;
    }

    if (player && !player.alive) {
      session.players.delete(playerId);
    }

    const spawn = this.findSpawnPoint(session);
    if (!spawn) {
      throw new Error('Unable to place player on the board');
    }

    const color = this.assignColor(session, playerId);
    player = {
      id: playerId,
      name: playerName,
      color,
      direction: spawn.direction,
      pendingDirection: null,
      body: spawn.body,
      alive: true,
      score: 0,
      joinedAt: Date.now(),
      lastInputAt: Date.now(),
    };

    session.players.set(playerId, player);
    session.spectators.delete(playerId);
    return player;
  }

  /**
   * Find a free spawn location for a new player
   */
  findSpawnPoint(session) {
    const { width, height } = session.board;
    const occupied = new Set();

    for (const player of session.players.values()) {
      if (!player.alive) {
        continue;
      }
      player.body.forEach((segment) => occupied.add(this.cellKey(segment)));
    }

    const attemptLimit = width * height;
    for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
      const x = Math.floor(Math.random() * width);
      const y = Math.floor(Math.random() * height);
      const direction = this.pickRandomDirection();
      const body = this.buildBodyFromHead({ x, y }, direction, 3, session.board);
      if (!body) {
        continue;
      }

      const collision = body.some((segment) => occupied.has(this.cellKey(segment)));
      if (collision) {
        continue;
      }

      return { body, direction };
    }

    return null;
  }

  /**
   * Construct snake body segments from a head position
   */
  buildBodyFromHead(head, direction, length, board) {
    const delta = DIRECTIONS[direction];
    if (!delta) {
      return null;
    }

    const body = [];
    for (let i = 0; i < length; i += 1) {
      const x = head.x - delta.x * i;
      const y = head.y - delta.y * i;
      if (x < 0 || y < 0 || x >= board.width || y >= board.height) {
        return null;
      }
      body.push({ x, y });
    }
    return body;
  }

  pickRandomDirection() {
    const keys = Object.keys(DIRECTIONS);
    return keys[Math.floor(Math.random() * keys.length)] || 'right';
  }

  assignColor(session, playerId) {
    const used = new Set();
    for (const player of session.players.values()) {
      if (player.color) {
        used.add(player.color);
      }
    }

    for (const color of COLOR_PALETTE) {
      if (!used.has(color)) {
        return color;
      }
    }

    const index = Math.floor(Math.random() * COLOR_PALETTE.length);
    return COLOR_PALETTE[index] || '#ffffff';
  }

  spawnFood(session) {
    const { width, height } = session.board;
    const occupied = new Set();

    for (const player of session.players.values()) {
      if (!player.alive) {
        continue;
      }
      player.body.forEach((segment) => occupied.add(this.cellKey(segment)));
    }

    let candidate = null;
    const attemptLimit = width * height;

    for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
      const x = Math.floor(Math.random() * width);
      const y = Math.floor(Math.random() * height);
      const key = this.cellKey({ x, y });
      if (!occupied.has(key)) {
        candidate = { x, y };
        break;
      }
    }

    if (!candidate) {
      candidate = {
        x: Math.floor(width / 2),
        y: Math.floor(height / 2),
      };
    }

    session.food = candidate;
    return candidate;
  }

  countAlivePlayers(session) {
    let count = 0;
    session.players.forEach((player) => {
      if (player.alive) {
        count += 1;
      }
    });
    return count;
  }

  cellKey(position) {
    return `${position.x}:${position.y}`;
  }

  isOutOfBounds(session, position) {
    return (
      position.x < 0 ||
      position.y < 0 ||
      position.x >= session.board.width ||
      position.y >= session.board.height
    );
  }

  /**
   * Convert session state into a client-friendly payload
   */
  serialize(session) {
    if (!session) {
      return null;
    }

    const players = Array.from(session.players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      score: player.score,
      alive: player.alive,
      direction: player.direction,
      body: player.body.map(({ x, y }) => ({ x, y })),
      lastInputAt: player.lastInputAt,
      joinedAt: player.joinedAt,
    }));

    players.sort((a, b) => {
      if (a.score === b.score) {
        return a.name.localeCompare(b.name);
      }
      return b.score - a.score;
    });

    return {
      gameId: session.id,
      channelId: session.channelId,
      type: session.type,
      status: session.status,
      hostId: session.hostId,
      hostName: session.hostName,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      sequence: session.sequence,
      board: { ...session.board },
      food: session.food ? { ...session.food } : null,
      players,
      spectators: Array.from(session.spectators.values()),
      lastAliveCount: session.lastAliveCount,
    };
  }

  notifyChannelUpdate() {
    try {
      this.onChannelUpdate?.();
    } catch (error) {
      logger.warn('Failed to notify channel update after minigame change', {
        error: error?.message,
      });
    }
  }
}
