import { generateId } from '../utils/helpers.js';
import logger from '../utils/logger.js';

const WORLD_WIDTH = 2600;
const WORLD_HEIGHT = 2000;
const TICK_INTERVAL_MS = 16; // ~60 updates per second

const PLAYER_START_LENGTH = 110;
const PLAYER_MIN_LENGTH = 90;
const PLAYER_MAX_LENGTH = 4600;
const PLAYER_RESPAWN_DELAY_MS = 3200;

const BASE_SPEED = 250;
const MIN_SPEED = 160;
const LENGTH_SLOWDOWN_FACTOR = 0.00032;
const TURN_RATE_RADIANS = Math.PI * 8;

const SEGMENT_SPACING = 14;
const SELF_COLLISION_SKIP = 10;
const MAX_SERIALIZED_SEGMENTS = 60;

const PELLET_COUNT = 120;
const PELLET_VALUE_MIN = 3;
const PELLET_VALUE_MAX = 7;
const PELLET_RADIUS_MIN = 7;
const PELLET_RADIUS_MAX = 11;
const PELLET_RESPAWN_BATCH = 8;

const DROP_PELLET_INTERVAL = 3;
const WORLD_PADDING = 120;
const INPUT_EPSILON = 0.02;

const COLOR_PALETTE = [
  '#ff6b6b',
  '#48dbfb',
  '#1dd1a1',
  '#feca57',
  '#5f27cd',
  '#ff9ff3',
  '#54a0ff',
  '#00d2d3',
  '#ff9b00',
  '#ff8b94',
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const randomBetween = (min, max) => Math.random() * (max - min) + min;

const distanceBetween = (a, b) => {
  if (!a || !b) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.hypot(a.x - b.x, a.y - b.y);
};

const normalizeAngle = (angle) => {
  let value = angle;
  while (value <= -Math.PI) {
    value += Math.PI * 2;
  }
  while (value > Math.PI) {
    value -= Math.PI * 2;
  }
  return value;
};

const rotateTowards = (current, target, maxDelta) => {
  const diff = normalizeAngle(target - current);
  if (Math.abs(diff) <= maxDelta) {
    return normalizeAngle(target);
  }
  return normalizeAngle(current + Math.sign(diff) * maxDelta);
};

const normalizeVector = (vector) => {
  const length = Math.hypot(vector?.x ?? 0, vector?.y ?? 0);
  if (!length || length < INPUT_EPSILON) {
    return { x: 0, y: 0 };
  }
  return { x: vector.x / length, y: vector.y / length };
};

const computeSpeed = (length) => {
  const slowdown = Math.max(length, PLAYER_MIN_LENGTH) - PLAYER_START_LENGTH;
  const reduction = slowdown * LENGTH_SLOWDOWN_FACTOR * BASE_SPEED;
  return clamp(BASE_SPEED - reduction, MIN_SPEED, BASE_SPEED);
};

const computeThickness = (length) => {
  const growth = Math.max(length, PLAYER_MIN_LENGTH) - PLAYER_START_LENGTH;
  return Math.max(12, 12 + growth * 0.018);
};

const sampleSegments = (segments, limit = MAX_SERIALIZED_SEGMENTS) => {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }
  if (segments.length <= limit) {
    return segments.slice();
  }
  const stride = Math.ceil(segments.length / limit);
  const sampled = [];
  for (let index = 0; index < segments.length; index += stride) {
    sampled.push(segments[index]);
  }
  const last = segments[segments.length - 1];
  const tail = sampled[sampled.length - 1];
  if (!tail || tail.x !== last.x || tail.y !== last.y) {
    sampled.push(last);
  }
  return sampled;
};

const scaledPoint = (point) => ({
  x: Number(point.x.toFixed(2)),
  y: Number(point.y.toFixed(2)),
});

export default class MinigameManager {
  constructor({ io, channelManager, onChannelUpdate }) {
    this.io = io;
    this.channelManager = channelManager;
    this.onChannelUpdate = typeof onChannelUpdate === 'function' ? onChannelUpdate : null;
    this.sessions = new Map(); // channelId -> session
  }

  startGame({ channelId, hostId, hostName, type = 'slither' }) {
    if (!channelId) {
      throw new Error('Channel is required to start a minigame');
    }

    const existing = this.sessions.get(channelId);
    if (existing && existing.status === 'running') {
      throw new Error('A minigame is already running in this channel');
    }

    if (type !== 'slither') {
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
      world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
      tickIntervalMs: TICK_INTERVAL_MS,
      sequence: 0,
      pellets: new Map(),
      players: new Map(),
      spectators: new Set(),
      intervalHandle: null,
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
      this.populatePellets(session, PELLET_COUNT);
      this.ensurePlayer(session, hostId, hostName, true);
    } catch (error) {
      this.sessions.delete(channelId);
      this.channelManager.clearChannelMinigame(channelId);
      logger.error('Failed to start slither arena', { error });
      throw error;
    }

    this.scheduleTick(session);
    this.notifyChannelUpdate();

    const state = this.serialize(session);
    this.io.to(channelId).emit('voice:game:started', state);
    logger.info('Slither arena started', { channelId, gameId: session.id });
    return state;
  }

  joinGame(channelId, playerId, playerName) {
    const session = this.sessions.get(channelId);
    if (!session || session.status !== 'running') {
      throw new Error('No active minigame in this channel');
    }

    const player = this.ensurePlayer(session, playerId, playerName, true);
    const state = this.serialize(session);
    this.io.to(channelId).emit('voice:game:update', state);
    logger.debug('Slither player joined', { channelId, gameId: session.id, playerId });
    return state;
  }

  leaveGame(channelId, playerId) {
    const session = this.sessions.get(channelId);
    if (!session) {
      throw new Error('Minigame not found');
    }

    const removed = session.players.delete(playerId);
    session.spectators.add(playerId);

    if (!removed) {
      return this.serialize(session);
    }

    if (session.hostId === playerId) {
      const nextHost = session.players.keys().next();
      if (!nextHost.done) {
        session.hostId = nextHost.value;
        session.hostName = session.players.get(nextHost.value)?.name ?? session.hostName;
      }
    }

    if (session.players.size === 0) {
      return this.endGame(channelId, 'all_players_left');
    }

    const state = this.serialize(session);
    this.io.to(channelId).emit('voice:game:update', state);
    logger.debug('Slither player left', { channelId, gameId: session.id, playerId });
    return state;
  }

  handleInput(channelId, playerId, vector) {
    const session = this.sessions.get(channelId);
    if (!session || session.status !== 'running') {
      throw new Error('No active minigame in this channel');
    }

    const player = session.players.get(playerId);
    if (!player) {
      throw new Error('Player is not part of this game');
    }

    const { x, y } = normalizeVector(vector);
    player.input = { x, y };
    player.lastInputAt = Date.now();
  }

  endGame(channelId, reason = 'ended_by_host') {
    const session = this.sessions.get(channelId);
    if (!session) {
      throw new Error('Minigame not found');
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
    logger.info('Slither arena ended', { channelId, gameId: session.id, reason });
    this.notifyChannelUpdate();
    return state;
  }

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

  getState(channelId) {
    const session = this.sessions.get(channelId);
    if (!session) {
      throw new Error('Minigame not found');
    }
    return this.serialize(session);
  }

  scheduleTick(session) {
    if (session.intervalHandle) {
      clearInterval(session.intervalHandle);
    }

    const tick = () => {
      try {
        this.tick(session);
      } catch (error) {
        logger.error('Slither tick failed', { error, channelId: session.channelId });
        this.endGame(session.channelId, 'error');
      }
    };

    session.intervalHandle = setInterval(tick, session.tickIntervalMs);
    session.intervalHandle.unref?.();
  }

  tick(session) {
    if (session.status !== 'running') {
      return;
    }

    const now = Date.now();
    const deltaSeconds = session.tickIntervalMs / 1000;

    session.sequence += 1;
    session.updatedAt = now;

    this.attemptRespawns(session, now);
    this.movePlayers(session, deltaSeconds);
    const pelletsConsumed = this.resolvePelletCollisions(session);
    const eliminations = this.resolvePlayerCollisions(session, now);

    if (pelletsConsumed > 0 || eliminations > 0) {
      this.populatePellets(session, Math.max(PELLET_RESPAWN_BATCH, pelletsConsumed));
    } else {
      this.populatePellets(session);
    }

    if (session.players.size === 0) {
      this.endGame(session.channelId, 'all_players_left');
      return;
    }

    const state = this.serialize(session);
    this.io.to(session.channelId).emit('voice:game:update', state);
  }

  attemptRespawns(session, now) {
    session.players.forEach((player) => {
      if (player.alive) {
        return;
      }
      if (!player.respawnAt || now < player.respawnAt) {
        return;
      }
      this.forceRespawn(session, player);
    });
  }

  movePlayers(session, deltaSeconds) {
    session.players.forEach((player) => {
      if (!player.alive) {
        return;
      }

      const vector = player.input ?? { x: 0, y: 0 };
      const hasInput = Math.hypot(vector.x, vector.y) >= INPUT_EPSILON;
      const targetAngle = hasInput ? Math.atan2(vector.y, vector.x) : player.heading;
      const maxTurn = TURN_RATE_RADIANS * deltaSeconds;
      player.heading = rotateTowards(player.heading, targetAngle, maxTurn);

      const speed = computeSpeed(player.length);
      player.speed = speed;

      const dx = Math.cos(player.heading) * speed * deltaSeconds;
      const dy = Math.sin(player.heading) * speed * deltaSeconds;

      let newHead = {
        x: player.head.x + dx,
        y: player.head.y + dy,
      };

      newHead = this.clampToArena(session.world, newHead, player.thickness ?? computeThickness(player.length));

      player.head = newHead;
      player.segments.unshift(newHead);
      this.trimSegments(player);
      player.thickness = computeThickness(player.length);
    });
  }

  resolvePelletCollisions(session) {
    const consumedIds = new Set();

    session.players.forEach((player) => {
      if (!player.alive) {
        return;
      }

      const head = player.head;
      const collisionRadius = (player.thickness ?? computeThickness(player.length)) * 0.6;

      session.pellets.forEach((pellet, pelletId) => {
        if (consumedIds.has(pelletId)) {
          return;
        }
        const distance = distanceBetween(head, pellet);
        if (distance <= collisionRadius + pellet.radius) {
          consumedIds.add(pelletId);
          player.length = clamp(player.length + pellet.value, PLAYER_MIN_LENGTH, PLAYER_MAX_LENGTH);
          player.score += pellet.value;
          player.thickness = computeThickness(player.length);
          player.speed = computeSpeed(player.length);
        }
      });
    });

    consumedIds.forEach((pelletId) => {
      session.pellets.delete(pelletId);
    });

    return consumedIds.size;
  }

  resolvePlayerCollisions(session, now) {
    const pendingDeaths = new Set();
    const alivePlayers = Array.from(session.players.values()).filter((player) => player.alive);

    const world = session.world;

    alivePlayers.forEach((player) => {
      const head = player.head;
      const margin = (player.thickness ?? computeThickness(player.length)) * 0.55;
      if (
        head.x <= WORLD_PADDING - margin ||
        head.x >= world.width - (WORLD_PADDING - margin) ||
        head.y <= WORLD_PADDING - margin ||
        head.y >= world.height - (WORLD_PADDING - margin)
      ) {
        pendingDeaths.add(player.id);
      }

      if (pendingDeaths.has(player.id)) {
        return;
      }

      for (let i = SELF_COLLISION_SKIP; i < player.segments.length; i += 1) {
        const point = player.segments[i];
        if (distanceBetween(head, point) <= margin) {
          pendingDeaths.add(player.id);
          break;
        }
      }
    });

    for (let i = 0; i < alivePlayers.length; i += 1) {
      const a = alivePlayers[i];
      if (pendingDeaths.has(a.id)) {
        continue;
      }
      for (let j = i + 1; j < alivePlayers.length; j += 1) {
        const b = alivePlayers[j];
        if (pendingDeaths.has(b.id)) {
          continue;
        }

        const headDistance = distanceBetween(a.head, b.head);
        const headThreshold = (a.thickness + b.thickness) * 0.45;
        if (headDistance <= headThreshold) {
          if (a.length === b.length) {
            pendingDeaths.add(a.id);
            pendingDeaths.add(b.id);
          } else if (a.length > b.length) {
            pendingDeaths.add(b.id);
          } else {
            pendingDeaths.add(a.id);
          }
          continue;
        }

        if (!pendingDeaths.has(a.id) && this.intersectsSegments(a.head, b.segments, 1, (a.thickness + b.thickness) * 0.45)) {
          pendingDeaths.add(a.id);
        }
        if (!pendingDeaths.has(b.id) && this.intersectsSegments(b.head, a.segments, 1, (a.thickness + b.thickness) * 0.45)) {
          pendingDeaths.add(b.id);
        }
      }
    }

    pendingDeaths.forEach((playerId) => {
      const player = session.players.get(playerId);
      if (!player || !player.alive) {
        return;
      }
      this.handleDeath(session, player, now);
    });

    return pendingDeaths.size;
  }

  intersectsSegments(head, segments, skip, threshold) {
    if (!segments || segments.length === 0) {
      return false;
    }

    const limit = segments.length;
    for (let index = skip; index < limit; index += 1) {
      const point = segments[index];
      if (distanceBetween(head, point) <= threshold) {
        return true;
      }
    }
    return false;
  }

  handleDeath(session, player, now) {
    player.alive = false;
    player.respawnAt = now + PLAYER_RESPAWN_DELAY_MS;
    player.input = { x: 0, y: 0 };
    this.dropPellets(session, player);
  }

  dropPellets(session, player) {
    const segments = player.segments;
    if (!segments || segments.length === 0) {
      return;
    }

    const dropSpacing = Math.max(DROP_PELLET_INTERVAL, Math.floor(segments.length / 40));
    for (let index = 0; index < segments.length; index += dropSpacing) {
      const point = segments[index];
      const pellet = this.createPellet(point.x, point.y, randomBetween(PELLET_VALUE_MIN, PELLET_VALUE_MAX));
      session.pellets.set(pellet.id, pellet);
      if (session.pellets.size > PELLET_COUNT * 2) {
        break;
      }
    }
  }

  forceRespawn(session, player) {
    const spawn = this.findSpawnPoint(session);
    const heading = randomBetween(-Math.PI, Math.PI);
    const segments = this.buildInitialSegments(spawn, heading, PLAYER_START_LENGTH);

    player.alive = true;
    player.length = PLAYER_START_LENGTH;
    player.thickness = computeThickness(player.length);
    player.speed = computeSpeed(player.length);
    player.head = segments[0];
    player.segments = segments;
    player.heading = heading;
    player.input = { x: 0, y: 0 };
    player.respawnAt = null;
  }

  ensurePlayer(session, playerId, playerName, spawnOnCreate = false) {
    let player = session.players.get(playerId);
    if (player) {
      player.name = playerName;
      if (spawnOnCreate && !player.alive) {
        this.forceRespawn(session, player);
      }
      session.spectators.delete(playerId);
      return player;
    }

    const spawn = this.findSpawnPoint(session);
    const heading = randomBetween(-Math.PI, Math.PI);
    const segments = this.buildInitialSegments(spawn, heading, PLAYER_START_LENGTH);
    const color = this.assignColor(session, playerId);

    player = {
      id: playerId,
      name: playerName,
      color,
      score: 0,
      alive: true,
      length: PLAYER_START_LENGTH,
      thickness: computeThickness(PLAYER_START_LENGTH),
      speed: computeSpeed(PLAYER_START_LENGTH),
      head: segments[0],
      segments,
      heading,
      input: { x: 0, y: 0 },
      respawnAt: null,
      lastInputAt: Date.now(),
      joinedAt: Date.now(),
    };

    session.players.set(playerId, player);
    session.spectators.delete(playerId);
    return player;
  }

  buildInitialSegments(spawn, heading, length) {
    const segments = [];
    const count = Math.max(8, Math.ceil(length / SEGMENT_SPACING));
    for (let i = 0; i <= count; i += 1) {
      const offset = i * SEGMENT_SPACING;
      const point = {
        x: spawn.x - Math.cos(heading) * offset,
        y: spawn.y - Math.sin(heading) * offset,
      };
      segments.push(point);
    }
    return segments;
  }

  trimSegments(player) {
    const desiredLength = clamp(player.length, PLAYER_MIN_LENGTH, PLAYER_MAX_LENGTH);
    let accumulated = 0;

    for (let i = 0; i < player.segments.length - 1; i += 1) {
      const current = player.segments[i];
      const next = player.segments[i + 1];
      const segmentDistance = distanceBetween(current, next);
      if (accumulated + segmentDistance >= desiredLength) {
        const excess = accumulated + segmentDistance - desiredLength;
        if (segmentDistance > 0) {
          const ratio = (segmentDistance - excess) / segmentDistance;
          player.segments[i + 1] = {
            x: current.x + (next.x - current.x) * ratio,
            y: current.y + (next.y - current.y) * ratio,
          };
        }
        player.segments.length = i + 2;
        return;
      }
      accumulated += segmentDistance;
    }

    const tail = player.segments[player.segments.length - 1];
    while (accumulated < desiredLength) {
      player.segments.push({ x: tail.x, y: tail.y });
      accumulated += SEGMENT_SPACING;
    }
  }

  clampToArena(world, point, thickness) {
    const margin = WORLD_PADDING + thickness * 0.5;
    return {
      x: clamp(point.x, margin, world.width - margin),
      y: clamp(point.y, margin, world.height - margin),
    };
  }

  findSpawnPoint(session) {
    const { world } = session;

    const attempts = 60;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const candidate = {
        x: randomBetween(WORLD_PADDING, world.width - WORLD_PADDING),
        y: randomBetween(WORLD_PADDING, world.height - WORLD_PADDING),
      };

      const safe = Array.from(session.players.values()).every((player) => {
        if (!player.alive) {
          return true;
        }
        const minDistance = (player.thickness ?? computeThickness(player.length)) + 120;
        return distanceBetween(player.head, candidate) > minDistance;
      });

      if (safe) {
        return candidate;
      }
    }

    return {
      x: world.width / 2,
      y: world.height / 2,
    };
  }

  assignColor(session, playerId) {
    const index = session.players.size % COLOR_PALETTE.length;
    return COLOR_PALETTE[index] ?? '#ffffff';
  }

  populatePellets(session, targetBatch = 0) {
    const target = Math.max(PELLET_COUNT, session.pellets.size);
    const desired = Math.min(target + targetBatch, PELLET_COUNT * 2);
    while (session.pellets.size < desired) {
      const pellet = this.spawnPellet(session);
      session.pellets.set(pellet.id, pellet);
    }
  }

  spawnPellet(session) {
    const { world } = session;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const x = randomBetween(WORLD_PADDING, world.width - WORLD_PADDING);
      const y = randomBetween(WORLD_PADDING, world.height - WORLD_PADDING);
      const point = { x, y };

      const nearPlayer = Array.from(session.players.values()).some((player) => {
        if (!player.alive) {
          return false;
        }
        return distanceBetween(player.head, point) < (player.thickness ?? computeThickness(player.length)) + 45;
      });

      if (nearPlayer) {
        continue;
      }

      return this.createPellet(x, y, randomBetween(PELLET_VALUE_MIN, PELLET_VALUE_MAX));
    }

    return this.createPellet(
      clamp(world.width / 2, WORLD_PADDING, world.width - WORLD_PADDING),
      clamp(world.height / 2, WORLD_PADDING, world.height - WORLD_PADDING),
      randomBetween(PELLET_VALUE_MIN, PELLET_VALUE_MAX),
    );
  }

  createPellet(x, y, value) {
    return {
      id: `pellet-${generateId(10)}`,
      x,
      y,
      value,
      radius: randomBetween(PELLET_RADIUS_MIN, PELLET_RADIUS_MAX),
      color: COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)] ?? '#ffffff',
    };
  }

  serialize(session) {
    if (!session) {
      return null;
    }

    const now = Date.now();

    const players = Array.from(session.players.values()).map((player) => {
      const segments = sampleSegments(player.segments);
      return {
        id: player.id,
        name: player.name,
        color: player.color,
        score: Math.round(player.score),
        alive: player.alive,
        length: Number(player.length.toFixed(1)),
        thickness: Number((player.thickness ?? computeThickness(player.length)).toFixed(2)),
        speed: Number((player.speed ?? computeSpeed(player.length)).toFixed(2)),
        head: scaledPoint(player.head),
        segments: segments.map(scaledPoint),
        respawning: !player.alive,
        respawnInMs: !player.alive && player.respawnAt ? Math.max(0, player.respawnAt - now) : 0,
        lastInputAt: player.lastInputAt,
        joinedAt: player.joinedAt,
      };
    });

    players.sort((a, b) => {
      if (a.length === b.length) {
        return b.score - a.score;
      }
      return b.length - a.length;
    });

    const pellets = Array.from(session.pellets.values()).map((pellet) => ({
      id: pellet.id,
      x: Number(pellet.x.toFixed(2)),
      y: Number(pellet.y.toFixed(2)),
      value: Number(pellet.value.toFixed(1)),
      radius: Number(pellet.radius.toFixed(2)),
      color: pellet.color,
    }));

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
      world: { ...session.world },
      pellets,
      players,
      leaderboard: players.slice(0, 5).map(({ id, name, score, length }) => ({ id, name, score, length })),
      spectators: Array.from(session.spectators.values()),
      tickIntervalMs: session.tickIntervalMs,
    };
  }

  notifyChannelUpdate() {
    if (this.onChannelUpdate) {
      try {
        this.onChannelUpdate();
      } catch (error) {
        logger.warn('Failed to notify channel update after slither change', { error });
      }
    }
  }
}
