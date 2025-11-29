import { generateId } from '../utils/helpers.js';
import logger from '../utils/logger.js';
import { getRandomPacmanMap, FALLBACK_PACMAN_MAP } from '../data/pacmanMaps/index.js';
import { getRedisStore } from '../storage/RedisStore.js';

const WORLD_WIDTH = 2600;
const WORLD_HEIGHT = 2000;
// Network optimization: 50ms tick = ~20 updates/sec (was 16ms = ~62 updates/sec)
// Still smooth for gameplay but 3x less bandwidth
const TICK_INTERVAL_MS = 50;
// Reduced segment count for network efficiency
const MAX_SERIALIZED_SEGMENTS = 40;

const PLAYER_START_LENGTH = 110;
const PLAYER_MIN_LENGTH = 90;
const PLAYER_MAX_LENGTH = 4600;
const PLAYER_RESPAWN_DELAY_MS = 3200;

const BASE_SPEED = 180;
const MIN_SPEED = 120;
const LENGTH_SLOWDOWN_FACTOR = 0.00032;
const TURN_RATE_RADIANS = Math.PI * 8;

const SEGMENT_SPACING = 14;
const SELF_COLLISION_SKIP = 10;

const PELLET_COUNT = 120;
const PELLET_VALUE_MIN = 3;
const PELLET_VALUE_MAX = 7;
const PELLET_RADIUS_MIN = 7;
const PELLET_RADIUS_MAX = 11;
const PELLET_RESPAWN_BATCH = 8;

const DROP_PELLET_INTERVAL = 3;
const WORLD_PADDING = 120;
const INPUT_EPSILON = 0.02;

// Delta compression: only send full pellet list every N ticks
const FULL_PELLET_SYNC_INTERVAL = 20;

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

// Pacman Constants
const PACMAN_TILE_SIZE = 40;
const PACMAN_SPEED = 150;
const PACMAN_POWER_DURATION = 6000;
const PACMAN_RESPAWN_DELAY = 3000;
const PACMAN_SETUP_DURATION_MS = 4000;
const PACMAN_ROUND_DURATION_MS = 180000;
const PACMAN_OVERTIME_DURATION_MS = 45000;
const PACMAN_RESET_DURATION_MS = 6000;
const PACMAN_OVERTIME_PELLET_RATIO = 0.25;
const PACMAN_OVERTIME_SPEED_MULTIPLIER = 1.35;
const PACMAN_POWERUP_BURST_COUNT = 3;

// Fighter Constants
const FIGHTER_STAGE_WIDTH = 1200;
const FIGHTER_STAGE_HEIGHT = 600;
const FIGHTER_GROUND_Y = 500;
const FIGHTER_GRAVITY = 2000;
const FIGHTER_JUMP_FORCE = -900;
const FIGHTER_MOVE_SPEED = 400;
const FIGHTER_ATTACK_DURATION = 300; // ms
const FIGHTER_HIT_STUN = 400; // ms
const FIGHTER_BLOCK_COOLDOWN = 500;
const FIGHTER_MAX_HEALTH = 100;
const FIGHTER_DAMAGE_PUNCH = 8;
const FIGHTER_DAMAGE_KICK = 12;
const FIGHTER_HITBOX_RANGE = 100;
const FIGHTER_ROUND_DURATION_MS = 99000; // 99 seconds

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const randomBetween = (min, max) => Math.random() * (max - min) + min;

const distanceBetween = (a, b) => {
  if (!a || !b) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.hypot(a.x - b.x, a.y - b.y);
};

const distanceBetweenSquared = (a, b) => {
  if (!a || !b) {
    return Number.POSITIVE_INFINITY;
  }
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
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

const snapToTileCenter = (value, tileSize = PACMAN_TILE_SIZE) => {
  return Math.floor(value / tileSize) * tileSize + tileSize / 2;
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

const scaledPoint = (point) => ({
  x: Math.round(point.x * 100) / 100,
  y: Math.round(point.y * 100) / 100,
});

const sampleAndScaleSegments = (segments, limit = MAX_SERIALIZED_SEGMENTS) => {
  if (!segments || segments.length === 0) {
    return [];
  }
  
  if (segments.length <= limit) {
    const result = new Array(segments.length);
    for (let i = 0; i < segments.length; i++) {
      result[i] = scaledPoint(segments[i]);
    }
    return result;
  }

  const stride = Math.ceil(segments.length / limit);
  const result = [];
  
  for (let index = 0; index < segments.length; index += stride) {
    result.push(scaledPoint(segments[index]));
  }
  
  const last = segments[segments.length - 1];
  const lastScaled = scaledPoint(last);
  const tail = result[result.length - 1];
  
  if (!tail || tail.x !== lastScaled.x || tail.y !== lastScaled.y) {
    result.push(lastScaled);
  }
  return result;
};

export default class MinigameManager {
  constructor({ io, channelManager, onChannelUpdate }) {
    this.io = io;
    this.channelManager = channelManager;
    this.onChannelUpdate = typeof onChannelUpdate === 'function' ? onChannelUpdate : null;
    this.sessions = new Map(); // channelId -> session
    this.redis = getRedisStore();
  }

  async saveScore(type, name, score) {
    if (!name || score <= 0) return;
    try {
      // Keep only the highest score for this user name
      // ZADD with GT (Greater Than) option would be ideal, but standard ZADD updates score.
      // To keep "highest ever", we might need to check first or use ZADD GT if available.
      // For simplicity, let's assume we want the latest high score or just update it.
      // Actually, usually leaderboards want the HIGHEST score.
      // Redis ZADD updates the score. If we want max, we should check.
      
      const currentScore = await this.redis.zscore('minigame', `leaderboard:${type}`, name);
      if (currentScore === null || score > currentScore) {
        await this.redis.zadd('minigame', `leaderboard:${type}`, score, name);
      }
    } catch (error) {
      logger.error('Failed to save minigame score', { error, type, name, score });
    }
  }

  async getLeaderboard(type, limit = 10) {
    try {
      return await this.redis.zrevrange('minigame', `leaderboard:${type}`, 0, limit - 1, true);
    } catch (error) {
      logger.error('Failed to get minigame leaderboard', { error, type });
      return [];
    }
  }

  startGame({ channelId, hostId, hostName, type = 'slither' }) {
    if (!channelId) {
      throw new Error('Channel is required to start a minigame');
    }

    const existing = this.sessions.get(channelId);
    if (existing && existing.status === 'running') {
      throw new Error('A minigame is already running in this channel');
    }

    if (type !== 'slither' && type !== 'pacman' && type !== 'fighter') {
      throw new Error('Unsupported minigame type');
    }

    const selectedPacmanMap = type === 'pacman' ? this.selectPacmanMap() : null;
    const world = type === 'pacman'
      ? {
          width: selectedPacmanMap.width,
          height: selectedPacmanMap.height,
          map: selectedPacmanMap.tiles,
          mapId: selectedPacmanMap.id,
          mapName: selectedPacmanMap.name,
          tileSize: selectedPacmanMap.tileSize,
              wrapRows: selectedPacmanMap.wrapRows,
        }
      : type === 'fighter'
      ? { width: FIGHTER_STAGE_WIDTH, height: FIGHTER_STAGE_HEIGHT }
      : { width: WORLD_WIDTH, height: WORLD_HEIGHT };

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
      world,
      pacmanMap: selectedPacmanMap,
      tickIntervalMs: TICK_INTERVAL_MS,
      sequence: 0,
      pellets: new Map(),
      // Delta compression tracking
      pelletChanges: { added: new Map(), removed: new Set() },
      lastFullPelletSync: 0,
      players: new Map(),
      spectators: new Set(),
      intervalHandle: null,
    };

    if (type === 'pacman') {
      this.initializePacmanState(session);
    } else if (type === 'fighter') {
      this.initializeFighterState(session);
    }

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
      if (type === 'slither') {
        this.populatePellets(session, PELLET_COUNT);
      } else if (type === 'pacman') {
        this.populatePacmanPellets(session);
      }
      this.ensurePlayer(session, hostId, hostName, true);
    } catch (error) {
      this.sessions.delete(channelId);
      this.channelManager.clearChannelMinigame(channelId);
      logger.error('Failed to start minigame', { error });
      throw error;
    }

    this.scheduleTick(session);
    this.notifyChannelUpdate();

    const state = this.serialize(session);
    this.io.to(channelId).emit('voice:game:started', state);
    logger.info('Minigame started', { channelId, gameId: session.id, type });
    return state;
  }

  selectPacmanMap() {
    const baseMap = (() => {
      try {
        return getRandomPacmanMap();
      } catch (error) {
        logger.warn('Failed to load pacman map, using fallback', { error });
        return FALLBACK_PACMAN_MAP;
      }
    })();

    return this.enrichPacmanMap(baseMap);
  }

  enrichPacmanMap(map) {
    const tiles = Array.isArray(map?.tiles) && map.tiles.length > 0
      ? map.tiles
      : FALLBACK_PACMAN_MAP.tiles;
    const width = tiles[0]?.length ?? 0;
    const height = tiles.length;
    const wrapRows = Array.isArray(map?.wrapRows) ? map.wrapRows : [];
    const tileSize = Number(map?.tileSize) || PACMAN_TILE_SIZE;

    return {
      id: map?.id ?? FALLBACK_PACMAN_MAP.id,
      name: map?.name ?? FALLBACK_PACMAN_MAP.name,
      tiles,
      wrapRows,
      wrapRowSet: map?.wrapRowSet ?? new Set(wrapRows),
      spawnTiles: Array.isArray(map?.spawnTiles) ? map.spawnTiles : [],
      powerPellets: Array.isArray(map?.powerPellets) ? map.powerPellets : [],
      tileSize,
      width: width * tileSize,
      height: height * tileSize,
    };
  }

  getPacmanMap(session) {
    if (session?.pacmanMap) {
      return session.pacmanMap;
    }
    return this.enrichPacmanMap(FALLBACK_PACMAN_MAP);
  }

  getPacmanTileSize(session) {
    const map = this.getPacmanMap(session);
    return map?.tileSize ?? PACMAN_TILE_SIZE;
  }

  initializePacmanState(session) {
    const now = Date.now();
    session.pacmanPhase = 'setup';
    session.phaseStartedAt = now;
    session.phaseEndsAt = now + PACMAN_SETUP_DURATION_MS;
    session.pacmanSpeedMultiplier = 1;
    session.initialPelletCount = 0;
    session.pacmanRound = 1;
  }

  initializeFighterState(session) {
    session.fighterRound = 1;
    session.roundStartedAt = Date.now();
    session.roundEndsAt = Date.now() + FIGHTER_ROUND_DURATION_MS;
    session.fighterPhase = 'fighting';
  }

  transitionPacmanPhase(session, phase, now, duration) {
    session.pacmanPhase = phase;
    session.phaseStartedAt = now;
    session.phaseEndsAt = duration ? now + duration : null;

    if (phase === 'live' || phase === 'setup' || phase === 'reset') {
      session.pacmanSpeedMultiplier = 1;
    } else if (phase === 'overtime') {
      session.pacmanSpeedMultiplier = PACMAN_OVERTIME_SPEED_MULTIPLIER;
    }
  }

  updatePacmanPhase(session, now) {
    if (session.type !== 'pacman') {
      return;
    }

    const pelletRatio = session.initialPelletCount > 0
      ? session.pellets.size / session.initialPelletCount
      : 1;

    switch (session.pacmanPhase) {
      case 'setup':
        if (session.phaseEndsAt && now >= session.phaseEndsAt) {
          this.transitionPacmanPhase(session, 'live', now, PACMAN_ROUND_DURATION_MS);
        }
        break;
      case 'live':
        if (pelletRatio <= PACMAN_OVERTIME_PELLET_RATIO || (session.phaseEndsAt && now >= session.phaseEndsAt)) {
          this.transitionPacmanPhase(session, 'overtime', now, PACMAN_OVERTIME_DURATION_MS);
          this.spawnPacmanPowerups(session, PACMAN_POWERUP_BURST_COUNT);
        }
        break;
      case 'overtime':
        if (session.pellets.size === 0 || (session.phaseEndsAt && now >= session.phaseEndsAt)) {
          this.resetPacmanRound(session, now);
        }
        break;
      case 'reset':
        if (session.phaseEndsAt && now >= session.phaseEndsAt) {
          this.transitionPacmanPhase(session, 'setup', now, PACMAN_SETUP_DURATION_MS);
        }
        break;
      default:
        break;
    }
  }

  resetPacmanRound(session, now) {
    this.populatePacmanPellets(session);
    session.players.forEach((player) => {
      this.forcePacmanRespawn(session, player);
    });
    session.pacmanRound = (session.pacmanRound ?? 1) + 1;
    this.transitionPacmanPhase(session, 'reset', now, PACMAN_RESET_DURATION_MS);
  }

  spawnPacmanPowerups(session, count = 2) {
    if (count <= 0) {
      return;
    }
    const pellets = Array.from(session.pellets.values()).filter((pellet) => !pellet.isPowerup);
    for (let i = 0; i < count && pellets.length > 0; i++) {
      const index = Math.floor(Math.random() * pellets.length);
      const pellet = pellets.splice(index, 1)[0];
      pellet.isPowerup = true;
      pellet.value = 60;
      pellet.color = '#fdd835';
      pellet.radius = 9;
      // Track the change for delta compression
      session.pelletChanges.added.set(pellet.id, pellet);
    }
  }

  joinGame(channelId, playerId, playerName) {
    const session = this.sessions.get(channelId);
    if (!session || session.status !== 'running') {
      throw new Error('No active minigame in this channel');
    }

    const player = this.ensurePlayer(session, playerId, playerName, true);
    // Force full pellet sync for the joining player
    const state = this.serialize(session, true);
    this.io.to(channelId).emit('voice:game:update', state);
    logger.debug('Slither player joined', { channelId, gameId: session.id, playerId });
    return state;
  }

  leaveGame(channelId, playerId) {
    const session = this.sessions.get(channelId);
    if (!session) {
      throw new Error('Minigame not found');
    }

    const player = session.players.get(playerId);
    if (player) {
      this.saveScore(session.type, player.name, player.maxScore || player.score);
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

  handleInput(channelId, playerId, payload) {
    const session = this.sessions.get(channelId);
    if (!session || session.status !== 'running') {
      throw new Error('No active minigame in this channel');
    }

    const player = session.players.get(playerId);
    if (!player) {
      throw new Error('Player is not part of this game');
    }

    if (session.type === 'fighter') {
      // Fighter input handling
      if (payload.action) {
        player.pendingAction = payload.action; // jump, punch, kick, block
      }
      if (payload.vector) {
        const { x, y } = normalizeVector(payload.vector);
        player.input = { x, y };
      }
    } else {
      // Slither/Pacman input handling (vector only)
      const vector = payload.vector || payload; // Handle both {vector: {x,y}} and {x,y}
      const { x, y } = normalizeVector(vector);
      player.input = { x, y };
    }
    
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

    // Save scores for all players
    for (const player of session.players.values()) {
      this.saveScore(session.type, player.name, player.maxScore || player.score);
    }

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

    if (session.type === 'pacman') {
      this.tickPacman(session);
      return;
    }

    if (session.type === 'fighter') {
      this.tickFighter(session);
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

  tickFighter(session) {
    const now = Date.now();
    const deltaSeconds = session.tickIntervalMs / 1000;

    session.sequence += 1;
    session.updatedAt = now;

    if (session.fighterPhase === 'fighting' && now >= session.roundEndsAt) {
      // Time over
      this.endFighterRound(session, 'timeout');
    }

    this.moveFighterPlayers(session, deltaSeconds);
    this.resolveFighterCollisions(session, now);

    if (session.players.size === 0) {
      this.endGame(session.channelId, 'all_players_left');
      return;
    }

    const state = this.serialize(session);
    this.io.to(session.channelId).emit('voice:game:update', state);
  }

  moveFighterPlayers(session, deltaSeconds) {
    session.players.forEach((player) => {
      if (!player.alive) return;

      // Gravity
      player.vy += FIGHTER_GRAVITY * deltaSeconds;

      // Stun Check
      if (player.stunnedUntil && player.stunnedUntil > Date.now()) {
        // Apply friction but no input
        player.vx *= 0.9;
      } else {
        // Input
        if (player.input && !player.isAttacking) {
          if (player.input.x < -0.1) {
            player.vx = -FIGHTER_MOVE_SPEED;
            player.facing = 'left';
          } else if (player.input.x > 0.1) {
            player.vx = FIGHTER_MOVE_SPEED;
            player.facing = 'right';
          } else {
            // Friction
            player.vx *= 0.8;
          }
        } else {
           player.vx *= 0.8;
        }

        // Actions
        if (player.pendingAction) {
          if (player.pendingAction === 'jump' && player.isGrounded) {
            player.vy = FIGHTER_JUMP_FORCE;
            player.isGrounded = false;
          } else if (player.pendingAction === 'punch' || player.pendingAction === 'kick') {
             if (!player.isAttacking && Date.now() > player.lastAttackAt + 500) {
               player.isAttacking = true;
               player.attackType = player.pendingAction;
               player.attackStartedAt = Date.now();
               player.lastAttackAt = Date.now();
               player.hasHitTarget = false;
             }
          } else if (player.pendingAction === 'block') {
             player.isBlocking = true;
             player.lastBlockAt = Date.now();
          }
          player.pendingAction = null;
        }
      }

      // Block decay
      if (player.isBlocking && Date.now() > player.lastBlockAt + 200) {
        player.isBlocking = false;
      }

      // Position Update
      player.x += player.vx * deltaSeconds;
      player.y += player.vy * deltaSeconds;

      // Ground Collision
      if (player.y >= FIGHTER_GROUND_Y) {
        player.y = FIGHTER_GROUND_Y;
        player.vy = 0;
        player.isGrounded = true;
      }

      // Wall Collision
      player.x = clamp(player.x, 50, FIGHTER_STAGE_WIDTH - 50);

      // Attack Duration
      if (player.isAttacking && Date.now() > player.attackStartedAt + FIGHTER_ATTACK_DURATION) {
        player.isAttacking = false;
        player.attackType = null;
      }
    });
  }

  resolveFighterCollisions(session, now) {
    const players = Array.from(session.players.values()).filter(p => p.alive);
    
    for (const attacker of players) {
      if (!attacker.isAttacking) continue;
      if (attacker.hasHitTarget) continue;
      // Cannot hit if stunned
      if (attacker.stunnedUntil && attacker.stunnedUntil > now) continue;

      const hitRange = FIGHTER_HITBOX_RANGE;
      const hitX = attacker.facing === 'right' ? attacker.x + hitRange/2 : attacker.x - hitRange/2;
      const hitY = attacker.y - 40;

      for (const victim of players) {
        if (attacker.id === victim.id) continue;

        const dx = Math.abs(victim.x - hitX);
        const dy = Math.abs(victim.y - hitY);

        if (dx < 60 && dy < 80) {
           attacker.hasHitTarget = true;
           
           if (victim.isBlocking && ((attacker.facing === 'right' && victim.facing === 'left') || (attacker.facing === 'left' && victim.facing === 'right'))) {
             // Blocked
             victim.vx += attacker.facing === 'right' ? 200 : -200;
             // Small stun on block
             victim.stunnedUntil = now + 100;
           } else {
             // Hit
             const damage = attacker.attackType === 'kick' ? FIGHTER_DAMAGE_KICK : FIGHTER_DAMAGE_PUNCH;
             victim.health = Math.max(0, victim.health - damage);
             victim.lastHitAt = now;
             victim.stunnedUntil = now + FIGHTER_HIT_STUN;
             
             victim.vx += attacker.facing === 'right' ? 300 : -300;
             victim.vy = -200;
             
             if (victim.health <= 0) {
               this.killFighter(session, victim, attacker);
             }
           }
        }
      }
    }
  }

  killFighter(session, victim, killer) {
    victim.alive = false;
    victim.score = Math.max(0, victim.score - 1);
    if (killer) {
      killer.score += 1;
    }
    // Respawn after delay
    setTimeout(() => {
      if (session.status === 'running' && session.players.has(victim.id)) {
        this.respawnFighter(session, victim);
      }
    }, 3000);
  }

  respawnFighter(session, player) {
    player.alive = true;
    player.health = FIGHTER_MAX_HEALTH;
    player.x = randomBetween(100, FIGHTER_STAGE_WIDTH - 100);
    player.y = 0; // Drop from sky
    player.vx = 0;
    player.vy = 0;
  }

  endFighterRound(session, reason) {
    // Reset positions or end game
    // For now, just reset health and positions
    session.players.forEach(p => this.respawnFighter(session, p));
    session.roundEndsAt = Date.now() + FIGHTER_ROUND_DURATION_MS;
  }

  tickPacman(session) {
    const now = Date.now();
    const deltaSeconds = session.tickIntervalMs / 1000;

    session.sequence += 1;
    session.updatedAt = now;

    this.updatePacmanPhase(session, now);
    this.attemptPacmanRespawns(session, now);
    const canMove = session.pacmanPhase === 'live' || session.pacmanPhase === 'overtime';
    if (canMove) {
      this.movePacmanPlayers(session, deltaSeconds);
      this.resolvePacmanCollisions(session, now);
    }

    if (session.players.size === 0) {
      this.endGame(session.channelId, 'all_players_left');
      return;
    }

    const state = this.serialize(session);
    this.io.to(session.channelId).emit('voice:game:update', state);
  }

  attemptPacmanRespawns(session, now) {
    session.players.forEach((player) => {
      if (player.alive) return;
      if (!player.respawnAt || now < player.respawnAt) return;
      this.forcePacmanRespawn(session, player);
    });
  }

  movePacmanPlayers(session, deltaSeconds) {
    const tileSize = this.getPacmanTileSize(session);
    const speedBoost = session.pacmanSpeedMultiplier ?? 1;

    session.players.forEach((player) => {
      if (!player.alive) return;

      // Handle Input Direction Change
      if (player.input && (player.input.x !== 0 || player.input.y !== 0)) {
        const inputDir = Math.abs(player.input.x) > Math.abs(player.input.y)
          ? (player.input.x > 0 ? 'right' : 'left')
          : (player.input.y > 0 ? 'down' : 'up');
        
        // Try to turn if aligned with grid
        if (this.canTurn(session, player, inputDir, tileSize)) {
          player.direction = inputDir;
          // Snap to grid axis when turning
          if (inputDir === 'left' || inputDir === 'right') {
            player.y = snapToTileCenter(player.y, tileSize);
          } else {
            player.x = snapToTileCenter(player.x, tileSize);
          }
        }
      }

      // Move
      const powerBonus = player.powerupExpiresAt && player.powerupExpiresAt > Date.now() ? 1.2 : 1.0;
      const speed = PACMAN_SPEED * speedBoost * powerBonus;
      const dist = speed * deltaSeconds;
      let dx = 0;
      let dy = 0;

      if (player.direction === 'left') dx = -dist;
      else if (player.direction === 'right') dx = dist;
      else if (player.direction === 'up') dy = -dist;
      else if (player.direction === 'down') dy = dist;

      // Collision Check with Walls
      const nextX = player.x + dx;
      const nextY = player.y + dy;
      
      if (this.isValidPosition(session, nextX, nextY, tileSize)) {
        player.x = nextX;
        player.y = nextY;
      } else {
        // Snap to center of current tile if hit wall
        const tileX = Math.floor(player.x / tileSize);
        const tileY = Math.floor(player.y / tileSize);
        player.x = tileX * tileSize + tileSize / 2;
        player.y = tileY * tileSize + tileSize / 2;
      }

      this.handlePacmanWrap(session, player);
    });
  }

  canTurn(session, player, direction, tileSize = this.getPacmanTileSize(session)) {
    // Allow turning if close to tile center
    const tileX = Math.floor(player.x / tileSize);
    const tileY = Math.floor(player.y / tileSize);
    const centerX = tileX * tileSize + tileSize / 2;
    const centerY = tileY * tileSize + tileSize / 2;
    
    const dx = player.x - centerX;
    const dy = player.y - centerY;
    if (dx * dx + dy * dy > 100) return false; // Must be close to center to turn

    let checkX = tileX;
    let checkY = tileY;
    if (direction === 'left') checkX--;
    if (direction === 'right') checkX++;
    if (direction === 'up') checkY--;
    if (direction === 'down') checkY++;

    return !this.isWall(session, checkX, checkY);
  }

  isValidPosition(session, x, y, tileSize = this.getPacmanTileSize(session)) {
    // Check corners of the bounding box
    const radius = 15;
    const points = [
      { x: x - radius, y: y - radius },
      { x: x + radius, y: y - radius },
      { x: x - radius, y: y + radius },
      { x: x + radius, y: y + radius },
    ];

    return points.every(p => !this.isWall(session, Math.floor(p.x / tileSize), Math.floor(p.y / tileSize)));
  }

  isWall(session, tx, ty) {
    const map = this.getPacmanMap(session);
    const tiles = map.tiles;
    if (ty < 0 || ty >= tiles.length) {
      return true;
    }

    const row = tiles[ty];
    if (tx < 0 || tx >= row.length) {
      const wrapRows = map.wrapRowSet ?? new Set(map.wrapRows ?? []);
      return !wrapRows.has(ty);
    }

    return row[tx] === 1;
  }

  handlePacmanWrap(session, player) {
    const map = this.getPacmanMap(session);
    const tileSize = map.tileSize ?? this.getPacmanTileSize(session);
    const tunnelRow = Math.floor(player.y / tileSize);
    const halfTile = tileSize / 2;
    const wrapRows = map.wrapRowSet ?? new Set(map.wrapRows ?? []);

    if (player.x < 0) {
      if (wrapRows.has(tunnelRow)) {
        player.x = session.world.width;
      } else {
        player.x = halfTile;
      }
    } else if (player.x > session.world.width) {
      if (wrapRows.has(tunnelRow)) {
        player.x = 0;
      } else {
        player.x = session.world.width - halfTile;
      }
    }

    player.y = clamp(player.y, halfTile, session.world.height - halfTile);
  }

  resolvePacmanCollisions(session, now) {
    const tileSize = this.getPacmanTileSize(session);
    // Pellets
    for (const player of session.players.values()) {
      if (!player.alive) continue;
      const tx = Math.floor(player.x / tileSize);
      const ty = Math.floor(player.y / tileSize);
      const key = `${tx},${ty}`;
      
      const pellet = session.pellets.get(key);
      if (pellet) {
        this.removePellet(session, key);
        player.score += pellet.value;
        if (player.score > (player.maxScore || 0)) {
          player.maxScore = player.score;
        }
        if (pellet.isPowerup) {
          player.powerupExpiresAt = now + PACMAN_POWER_DURATION;
        }
      }
    }

    // PvP
    const players = [];
    for (const p of session.players.values()) {
      if (p.alive) players.push(p);
    }

    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const p1 = players[i];
        const p2 = players[j];
        if (distanceBetweenSquared(p1, p2) < 900) {
          const p1Powered = p1.powerupExpiresAt && p1.powerupExpiresAt > now;
          const p2Powered = p2.powerupExpiresAt && p2.powerupExpiresAt > now;

          if (p1Powered && !p2Powered) {
            this.killPacman(session, p2, now, p1);
          } else if (p2Powered && !p1Powered) {
            this.killPacman(session, p1, now, p2);
          }
          // If both powered or neither, bounce? or nothing.
        }
      }
    }
  }

  killPacman(session, victim, now, killer) {
    victim.alive = false;
    victim.respawnAt = now + PACMAN_RESPAWN_DELAY;
    victim.score = Math.max(0, victim.score - 50);
    if (killer) {
      killer.score += 200;
      if (killer.score > (killer.maxScore || 0)) {
        killer.maxScore = killer.score;
      }
    }
  }

  forcePacmanRespawn(session, player) {
    const spawn = this.findPacmanSpawn(session);
    player.alive = true;
    player.x = spawn.x;
    player.y = spawn.y;
    player.direction = 'right';
    player.powerupExpiresAt = null;
    player.respawnAt = null;
  }

  findPacmanSpawn(session) {
    const map = this.getPacmanMap(session);
    const tileSize = map.tileSize ?? PACMAN_TILE_SIZE;
    const tiles = map.tiles;
    const width = tiles[0]?.length ?? 0;
    const height = tiles.length;
    const isWalkable = (x, y) => y >= 0 && y < height && x >= 0 && x < width && tiles[y][x] === 0;

    const spawnPool = Array.isArray(map.spawnTiles) ? map.spawnTiles.filter(({ x, y }) => isWalkable(x, y)) : [];
    if (spawnPool.length > 0) {
      const choice = spawnPool[Math.floor(Math.random() * spawnPool.length)];
      return {
        x: choice.x * tileSize + tileSize / 2,
        y: choice.y * tileSize + tileSize / 2,
      };
    }

    for (let i = 0; i < 80; i++) {
      const ty = Math.floor(Math.random() * height);
      const tx = Math.floor(Math.random() * width);
      if (isWalkable(tx, ty)) {
        return {
          x: tx * tileSize + tileSize / 2,
          y: ty * tileSize + tileSize / 2,
        };
      }
    }

    return { x: tileSize * 1.5, y: tileSize * 1.5 };
  }

  populatePacmanPellets(session) {
    const map = this.getPacmanMap(session);
    const tileSize = map.tileSize ?? PACMAN_TILE_SIZE;
    const tiles = map.tiles;
    const powerPelletKeys = new Set(
      (map.powerPellets ?? []).map(({ x, y }) => `${x},${y}`)
    );

    session.pellets.clear();

    for (let y = 0; y < tiles.length; y++) {
      for (let x = 0; x < tiles[y].length; x++) {
        if (tiles[y][x] !== 0) {
          continue;
        }

        const key = `${x},${y}`;
        const isPowerup = powerPelletKeys.has(key);
        const pellet = {
          id: key,
          x: x * tileSize + tileSize / 2,
          y: y * tileSize + tileSize / 2,
          value: isPowerup ? 50 : 10,
          color: isPowerup ? '#ffeb3b' : '#ffb74d',
          isPowerup,
          radius: isPowerup ? 8 : 3,
        };
        session.pellets.set(pellet.id, pellet);
      }
    }

    session.initialPelletCount = session.pellets.size;
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

    for (const player of session.players.values()) {
      if (!player.alive) continue;

      const head = player.head;
      const collisionRadius = (player.thickness ?? computeThickness(player.length)) * 0.6;

      for (const pellet of session.pellets.values()) {
        if (consumedIds.has(pellet.id)) continue;

        const distSq = distanceBetweenSquared(head, pellet);
        const threshold = collisionRadius + pellet.radius;

        if (distSq <= threshold * threshold) {
          consumedIds.add(pellet.id);
          player.length = clamp(player.length + pellet.value, PLAYER_MIN_LENGTH, PLAYER_MAX_LENGTH);
          player.score += pellet.value;
          if (player.score > (player.maxScore || 0)) {
            player.maxScore = player.score;
          }
          player.thickness = computeThickness(player.length);
          player.speed = computeSpeed(player.length);
        }
      }
    }

    consumedIds.forEach((pelletId) => {
      this.removePellet(session, pelletId);
    });

    return consumedIds.size;
  }

  resolvePlayerCollisions(session, now) {
    const pendingDeaths = new Set();
    const alivePlayers = [];
    for (const player of session.players.values()) {
      if (player.alive) alivePlayers.push(player);
    }

    const world = session.world;

    for (const player of alivePlayers) {
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
        continue;
      }

      const marginSq = margin * margin;
      for (let i = SELF_COLLISION_SKIP; i < player.segments.length; i += 1) {
        const point = player.segments[i];
        if (distanceBetweenSquared(head, point) <= marginSq) {
          pendingDeaths.add(player.id);
          break;
        }
      }
    }

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

        const headDistSq = distanceBetweenSquared(a.head, b.head);
        const headThreshold = (a.thickness + b.thickness) * 0.45;
        
        if (headDistSq <= headThreshold * headThreshold) {
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

        if (!pendingDeaths.has(a.id) && this.intersectsSegments(a.head, b.segments, 1, headThreshold)) {
          pendingDeaths.add(a.id);
        }
        if (!pendingDeaths.has(b.id) && this.intersectsSegments(b.head, a.segments, 1, headThreshold)) {
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

    const thresholdSq = threshold * threshold;
    const limit = segments.length;
    for (let index = skip; index < limit; index += 1) {
      const point = segments[index];
      if (distanceBetweenSquared(head, point) <= thresholdSq) {
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
      this.addPellet(session, pellet);
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
        if (session.type === 'pacman') this.forcePacmanRespawn(session, player);
        else this.forceRespawn(session, player);
      }
      session.spectators.delete(playerId);
      return player;
    }

    const color = this.assignColor(session, playerId);

    if (session.type === 'pacman') {
      const spawn = this.findPacmanSpawn(session);
      player = {
        id: playerId,
        name: playerName,
        color,
        score: 0,
        maxScore: 0,
        alive: true,
        x: spawn.x,
        y: spawn.y,
        direction: 'right',
        powerupExpiresAt: null,
        respawnAt: null,
        lastInputAt: Date.now(),
        joinedAt: Date.now(),
      };
    } else if (session.type === 'fighter') {
      player = {
        id: playerId,
        name: playerName,
        color,
        score: 0,
        alive: true,
        x: 200 + (session.players.size * 200),
        y: FIGHTER_GROUND_Y,
        vx: 0,
        vy: 0,
        health: FIGHTER_MAX_HEALTH,
        facing: 'right',
        isGrounded: true,
        isAttacking: false,
        isBlocking: false,
        stunnedUntil: 0,
        lastAttackAt: 0,
        joinedAt: Date.now(),
      };
    } else {
      const spawn = this.findSpawnPoint(session);
      const heading = randomBetween(-Math.PI, Math.PI);
      const segments = this.buildInitialSegments(spawn, heading, PLAYER_START_LENGTH);
      player = {
        id: playerId,
        name: playerName,
        color,
        score: 0,
        maxScore: 0,
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
    }

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

      let safe = true;
      for (const player of session.players.values()) {
        if (!player.alive) continue;
        const minDistance = (player.thickness ?? computeThickness(player.length)) + 120;
        if (distanceBetweenSquared(player.head, candidate) <= minDistance * minDistance) {
          safe = false;
          break;
        }
      }

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
      this.addPellet(session, pellet);
    }
  }

  spawnPellet(session) {
    const { world } = session;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const x = randomBetween(WORLD_PADDING, world.width - WORLD_PADDING);
      const y = randomBetween(WORLD_PADDING, world.height - WORLD_PADDING);
      const point = { x, y };

      let nearPlayer = false;
      for (const player of session.players.values()) {
        if (!player.alive) continue;
        const threshold = (player.thickness ?? computeThickness(player.length)) + 45;
        if (distanceBetweenSquared(player.head, point) < threshold * threshold) {
          nearPlayer = true;
          break;
        }
      }

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

  // Helper to add pellet with delta tracking
  addPellet(session, pellet) {
    session.pellets.set(pellet.id, pellet);
    // Track addition for delta compression (unless it was just removed this tick)
    if (session.pelletChanges.removed.has(pellet.id)) {
      session.pelletChanges.removed.delete(pellet.id);
    } else {
      session.pelletChanges.added.set(pellet.id, pellet);
    }
  }

  // Helper to remove pellet with delta tracking
  removePellet(session, pelletId) {
    const pellet = session.pellets.get(pelletId);
    if (!pellet) return false;
    session.pellets.delete(pelletId);
    // Track removal for delta compression (unless it was just added this tick)
    if (session.pelletChanges.added.has(pelletId)) {
      session.pelletChanges.added.delete(pelletId);
    } else {
      session.pelletChanges.removed.add(pelletId);
    }
    return true;
  }

  serialize(session, forceFullPellets = false) {
    if (!session) {
      return null;
    }

    const now = Date.now();
    const players = [];

    for (const player of session.players.values()) {
      if (session.type === 'pacman') {
        players.push({
          id: player.id,
          name: player.name,
          color: player.color,
          score: Math.round(player.score),
          alive: player.alive,
          x: Math.round(player.x * 100) / 100,
          y: Math.round(player.y * 100) / 100,
          direction: player.direction,
          powerupExpiresAt: player.powerupExpiresAt,
          respawning: !player.alive,
          respawnInMs: !player.alive && player.respawnAt ? Math.max(0, player.respawnAt - now) : 0,
          lastInputAt: player.lastInputAt,
          joinedAt: player.joinedAt,
        });
      } else if (session.type === 'fighter') {
        players.push({
          id: player.id,
          name: player.name,
          color: player.color,
          score: Math.round(player.score),
          alive: player.alive,
          x: Math.round(player.x * 100) / 100,
          y: Math.round(player.y * 100) / 100,
          vx: Math.round(player.vx * 100) / 100,
          vy: Math.round(player.vy * 100) / 100,
          health: player.health,
          facing: player.facing,
          isGrounded: player.isGrounded,
          isAttacking: player.isAttacking,
          attackType: player.attackType,
          isBlocking: player.isBlocking,
          isStunned: player.stunnedUntil && player.stunnedUntil > now,
          respawning: !player.alive,
          respawnInMs: !player.alive && player.respawnAt ? Math.max(0, player.respawnAt - now) : 0,
          lastInputAt: player.lastInputAt,
          joinedAt: player.joinedAt,
        });
      } else {
        const segments = sampleAndScaleSegments(player.segments);
        players.push({
          id: player.id,
          name: player.name,
          color: player.color,
          score: Math.round(player.score),
          alive: player.alive,
          length: Math.round(player.length * 10) / 10,
          thickness: Math.round((player.thickness ?? computeThickness(player.length)) * 100) / 100,
          speed: Math.round((player.speed ?? computeSpeed(player.length)) * 100) / 100,
          head: scaledPoint(player.head),
          segments,
          respawning: !player.alive,
          respawnInMs: !player.alive && player.respawnAt ? Math.max(0, player.respawnAt - now) : 0,
          lastInputAt: player.lastInputAt,
          joinedAt: player.joinedAt,
        });
      }
    }

    players.sort((a, b) => {
      if (session.type === 'pacman') return b.score - a.score;
      if (a.length === b.length) {
        return b.score - a.score;
      }
      return b.length - a.length;
    });

    // Delta compression for pellets:
    // - Send full pellet list periodically or when forced (join, start)
    // - Otherwise send only added/removed pellets
    const shouldSendFullPellets = forceFullPellets || 
      (session.sequence - session.lastFullPelletSync >= FULL_PELLET_SYNC_INTERVAL);
    
    let pelletData;
    if (shouldSendFullPellets) {
      // Full sync - send all pellets
      const pellets = [];
      for (const pellet of session.pellets.values()) {
        pellets.push({
          id: pellet.id,
          x: Math.round(pellet.x * 100) / 100,
          y: Math.round(pellet.y * 100) / 100,
          value: Math.round(pellet.value * 10) / 10,
          radius: Math.round(pellet.radius * 100) / 100,
          color: pellet.color,
          isPowerup: pellet.isPowerup
        });
      }
      pelletData = {
        full: true,
        pellets,
      };
      session.lastFullPelletSync = session.sequence;
      // Clear delta tracking after full sync
      session.pelletChanges.added.clear();
      session.pelletChanges.removed.clear();
    } else {
      // Delta sync - only send changes
      const added = [];
      for (const pellet of session.pelletChanges.added.values()) {
        added.push({
          id: pellet.id,
          x: Math.round(pellet.x * 100) / 100,
          y: Math.round(pellet.y * 100) / 100,
          value: Math.round(pellet.value * 10) / 10,
          radius: Math.round(pellet.radius * 100) / 100,
          color: pellet.color,
          isPowerup: pellet.isPowerup
        });
      }
      
      pelletData = {
        full: false,
        added,
        removed: Array.from(session.pelletChanges.removed),
        count: session.pellets.size,
      };
      // Clear delta tracking after sending
      session.pelletChanges.added.clear();
      session.pelletChanges.removed.clear();
    }

    const pacmanState = session.type === 'pacman'
      ? {
          phase: session.pacmanPhase,
          phaseStartedAt: session.phaseStartedAt,
          phaseEndsAt: session.phaseEndsAt,
          speedMultiplier: session.pacmanSpeedMultiplier ?? 1,
          round: session.pacmanRound ?? 1,
          initialPellets: session.initialPelletCount ?? session.pellets.size,
          pelletsRemaining: session.pellets?.size ?? 0,
        }
      : null;

    const fighterState = session.type === 'fighter'
      ? {
          round: session.fighterRound,
          roundEndsAt: session.roundEndsAt,
          phase: session.fighterPhase,
        }
      : null;

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
      pelletData,
      players,
      leaderboard: players.slice(0, 5).map(({ id, name, score, length }) => ({ id, name, score, length })),
      spectators: Array.from(session.spectators),
      tickIntervalMs: session.tickIntervalMs,
      pacmanState,
      fighterState,
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
