import { generateId } from '../utils/helpers.js';
import logger from '../utils/logger.js';
import { getRandomPacmanMap, FALLBACK_PACMAN_MAP } from '../data/pacmanMaps/index.js';

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

    if (type !== 'slither' && type !== 'pacman') {
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

    if (session.type === 'pacman') {
      this.tickPacman(session);
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
    
    const dist = Math.hypot(player.x - centerX, player.y - centerY);
    if (dist > 10) return false; // Must be close to center to turn

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
    session.players.forEach(player => {
      if (!player.alive) return;
      const tx = Math.floor(player.x / tileSize);
      const ty = Math.floor(player.y / tileSize);
      const key = `${tx},${ty}`;
      
      const pellet = session.pellets.get(key);
      if (pellet) {
        this.removePellet(session, key);
        player.score += pellet.value;
        if (pellet.isPowerup) {
          player.powerupExpiresAt = now + PACMAN_POWER_DURATION;
        }
      }
    });

    // PvP
    const players = Array.from(session.players.values()).filter(p => p.alive);
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const p1 = players[i];
        const p2 = players[j];
        if (Math.hypot(p1.x - p2.x, p1.y - p2.y) < 30) {
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
      this.removePellet(session, pelletId);
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
        alive: true,
        x: spawn.x,
        y: spawn.y,
        direction: 'right',
        powerupExpiresAt: null,
        respawnAt: null,
        lastInputAt: Date.now(),
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
      this.addPellet(session, pellet);
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

    const players = Array.from(session.players.values()).map((player) => {
      if (session.type === 'pacman') {
        return {
          id: player.id,
          name: player.name,
          color: player.color,
          score: Math.round(player.score),
          alive: player.alive,
          x: Number(player.x.toFixed(2)),
          y: Number(player.y.toFixed(2)),
          direction: player.direction,
          powerupExpiresAt: player.powerupExpiresAt,
          respawning: !player.alive,
          respawnInMs: !player.alive && player.respawnAt ? Math.max(0, player.respawnAt - now) : 0,
          lastInputAt: player.lastInputAt,
          joinedAt: player.joinedAt,
        };
      }

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
      pelletData = {
        full: true,
        pellets: Array.from(session.pellets.values()).map((pellet) => ({
          id: pellet.id,
          x: Number(pellet.x.toFixed(2)),
          y: Number(pellet.y.toFixed(2)),
          value: Number(pellet.value.toFixed(1)),
          radius: Number(pellet.radius.toFixed(2)),
          color: pellet.color,
          isPowerup: pellet.isPowerup
        })),
      };
      session.lastFullPelletSync = session.sequence;
      // Clear delta tracking after full sync
      session.pelletChanges.added.clear();
      session.pelletChanges.removed.clear();
    } else {
      // Delta sync - only send changes
      pelletData = {
        full: false,
        added: Array.from(session.pelletChanges.added.values()).map((pellet) => ({
          id: pellet.id,
          x: Number(pellet.x.toFixed(2)),
          y: Number(pellet.y.toFixed(2)),
          value: Number(pellet.value.toFixed(1)),
          radius: Number(pellet.radius.toFixed(2)),
          color: pellet.color,
          isPowerup: pellet.isPowerup
        })),
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
          initialPellets: session.initialPelletCount ?? pellets.length,
          pelletsRemaining: session.pellets?.size ?? pellets.length,
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
      spectators: Array.from(session.spectators.values()),
      tickIntervalMs: session.tickIntervalMs,
      pacmanState,
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
