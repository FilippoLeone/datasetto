import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from '@/lib/EventEmitter';
import { CameraEffects, type BlurSessionLike, type EffectsEnvironment, type SessionEvents } from './cameraEffects';
import type { BlurPath, BlurSupport, BlurTier, BlurWindow, CameraBlurStatus } from './backgroundBlur';

/** A camera track: optional system blur capability, constraints that remember what was applied. */
const fakeCamera = (backgroundBlur?: boolean[]) => {
  let constraints: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
  return {
    kind: 'video',
    getCapabilities: () => (backgroundBlur ? { backgroundBlur } : {}),
    getConstraints: () => constraints,
    applyConstraints: vi.fn(async (next: MediaTrackConstraints) => {
      constraints = next;
    }),
    getSettings: () => ({ width: 1280, height: 720 }),
  } as unknown as MediaStreamTrack & { applyConstraints: ReturnType<typeof vi.fn> };
};

class FakeSession extends EventEmitter<SessionEvents> implements BlurSessionLike {
  readonly track = { kind: 'video', id: 'blurred' } as unknown as MediaStreamTrack;
  readonly sources: MediaStreamTrack[] = [];
  readonly tiers: BlurTier[] = [];
  closed = false;
  failStart: string | null = null;

  constructor(
    readonly path: Exclude<BlurPath, 'none'>,
    tier: BlurTier,
  ) {
    super();
    this.tiers.push(tier);
  }

  async use(source: MediaStreamTrack): Promise<void> {
    this.sources.push(source);
    if (this.failStart) throw new Error(this.failStart);
  }

  setTier(tier: BlurTier): void {
    this.tiers.push(tier);
  }

  close(): void {
    this.closed = true;
  }
}

const setup = (options: { support?: BlurSupport; costly?: boolean; failStart?: string } = {}) => {
  const sessions: FakeSession[] = [];
  const env: EffectsEnvironment = {
    support: () => options.support ?? { path: 'insertable', reason: null },
    costly: () => options.costly ?? false,
    createSession: (path, tier) => {
      const session = new FakeSession(path, tier);
      session.failStart = options.failStart ?? null;
      sessions.push(session);
      return session;
    },
  };
  const effects = new CameraEffects(env);
  const statuses: CameraBlurStatus[] = [];
  effects.on('status', (status) => statuses.push(status));
  const fallback = vi.fn();
  effects.on('fallback', fallback);
  return { effects, sessions, statuses, fallback };
};

const slow: BlurWindow = { inputFrames: 30, outputFrames: 12, durationMs: 1000, meanLatencyMs: 50, p95LatencyMs: 70, meanCostMs: 40 };
const fine: BlurWindow = { inputFrames: 30, outputFrames: 30, durationMs: 1000, meanLatencyMs: 10, p95LatencyMs: 14, meanCostMs: 11 };

/** Sends windows until the governor (2 warm-up windows, 3 slow ones) steps down once. */
const stepDown = (session: FakeSession) => {
  for (let i = 0; i < 5; i++) session.emit('stats', { window: slow, segmentMs: 30, composeMs: 1 });
};

describe('CameraEffects', () => {
  it('sends the camera itself when blur is off and starts nothing', async () => {
    const { effects, sessions } = setup();
    const camera = fakeCamera();
    expect(await effects.apply(camera, 'off')).toBe(camera);
    expect(sessions).toHaveLength(0);
    expect(effects.status.state).toBe('off');
  });

  it('sends the blurred copy, switches levels on the same track and keeps it across a camera flip', async () => {
    const { effects, sessions, statuses } = setup();
    const camera = fakeCamera();
    const sent = await effects.apply(camera, 'strong');
    expect(sessions).toHaveLength(1);
    expect(sent).toBe(sessions[0].track);
    expect(statuses.map((s) => s.state)).toEqual(['starting', 'running']);
    expect(effects.status).toMatchObject({ engine: 'device', tier: { level: 'strong', segmentEvery: 1 }, modelReady: false });
    sessions[0].emit('model-ready', undefined);
    expect(effects.status.modelReady).toBe(true);

    // Light: the same session and track, a new tier.
    expect(await effects.apply(camera, 'light')).toBe(sessions[0].track);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].tiers.at(-1)).toEqual({ level: 'light', segmentEvery: 1 });

    // Another camera: the session takes the new input, the sent track stays.
    const back = fakeCamera();
    expect(await effects.apply(back, 'light')).toBe(sessions[0].track);
    expect(sessions[0].sources).toEqual([camera, back]);

    // Off: the session closes and the camera itself is sent.
    expect(await effects.apply(back, 'off')).toBe(back);
    expect(sessions[0].closed).toBe(true);
    expect(effects.status.state).toBe('off');
  });

  it('starts phones at every 2nd frame', async () => {
    const { effects, sessions } = setup({ costly: true });
    await effects.apply(fakeCamera(), 'light');
    expect(sessions[0].tiers[0]).toEqual({ level: 'light', segmentEvery: 2 });
  });

  it('uses the system camera effects when the page may switch them, and switches them off again', async () => {
    const { effects, sessions } = setup();
    const camera = fakeCamera([false, true]);
    expect(await effects.apply(camera, 'strong')).toBe(camera);
    expect(sessions).toHaveLength(0);
    expect(camera.applyConstraints).toHaveBeenLastCalledWith({ width: { ideal: 1280 }, height: { ideal: 720 }, backgroundBlur: true });
    expect(effects.status).toMatchObject({ state: 'running', engine: 'system' });
    await effects.apply(camera, 'off');
    expect(camera.applyConstraints).toHaveBeenLastCalledWith(expect.objectContaining({ backgroundBlur: false }));
  });

  it('falls back to on-device blur when the system refuses to switch its effects on', async () => {
    const { effects, sessions } = setup();
    const camera = fakeCamera([false, true]);
    camera.applyConstraints.mockRejectedValueOnce(new Error('OverconstrainedError'));
    expect(await effects.apply(camera, 'light')).toBe(sessions[0].track);
    expect(effects.status.engine).toBe('device');
  });

  it('says so when the system already blurs the camera', async () => {
    const { effects, sessions } = setup();
    const camera = fakeCamera([true]);
    expect(await effects.apply(camera, 'light')).toBe(camera);
    expect(sessions).toHaveLength(0);
    expect(effects.status).toMatchObject({ engine: 'system', state: 'running' });
    expect(effects.status.notice).toMatch(/already blur/);
    await effects.apply(camera, 'off');
    expect(effects.status.notice).toMatch(/turn them off/);
  });

  it('reports why blur is unavailable and sends the camera as it is', async () => {
    const { effects, sessions } = setup({ support: { path: 'none', reason: 'No WebGL 2 here.' } });
    const camera = fakeCamera();
    expect(await effects.apply(camera, 'strong')).toBe(camera);
    expect(sessions).toHaveLength(0);
    expect(effects.status).toMatchObject({ state: 'failed', notice: 'No WebGL 2 here.' });
  });

  it('gives up when the worker cannot start, until the level or the camera changes', async () => {
    const { effects, sessions } = setup({ failStart: 'the blur worker did not start in time' });
    const camera = fakeCamera();
    expect(await effects.apply(camera, 'strong')).toBe(camera);
    expect(sessions[0].closed).toBe(true);
    expect(effects.status.state).toBe('failed');
    expect(effects.status.notice).toMatch(/could not start: the blur worker did not start in time/);
    // The same pick again does not retry.
    expect(await effects.apply(camera, 'strong')).toBe(camera);
    expect(sessions).toHaveLength(1);
    // A new pick does.
    await effects.apply(camera, 'light');
    expect(sessions).toHaveLength(2);
    // So does the next camera session.
    effects.stop();
    await effects.apply(camera, 'light');
    expect(sessions).toHaveLength(3);
  });

  it('steps down: every 2nd frame, then Light, then every 3rd frame, then off with a notice', async () => {
    const { effects, sessions, fallback } = setup();
    const camera = fakeCamera();
    await effects.apply(camera, 'strong');
    const session = sessions[0];
    // Slow windows before the model is ready do not count.
    stepDown(session);
    expect(session.tiers).toHaveLength(1);
    session.emit('model-ready', undefined);
    session.emit('stats', { window: fine, segmentMs: 11, composeMs: 1 });
    expect(effects.status.stats).toMatchObject({ fps: 30, latencyMs: 14, segmentEvery: 1 });

    stepDown(session);
    expect(session.tiers.at(-1)).toEqual({ level: 'strong', segmentEvery: 2 });
    expect(effects.status.notice).toBeNull();
    stepDown(session);
    expect(session.tiers.at(-1)).toEqual({ level: 'light', segmentEvery: 2 });
    expect(effects.status.notice).toMatch(/Light is used/);
    // A camera flip keeps the step-down.
    await effects.apply(fakeCamera(), 'strong');
    expect(session.tiers.at(-1)).toEqual({ level: 'light', segmentEvery: 2 });
    stepDown(session);
    expect(session.tiers.at(-1)).toEqual({ level: 'light', segmentEvery: 3 });
    expect(fallback).not.toHaveBeenCalled();
    stepDown(session);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(session.closed).toBe(true);
    expect(effects.status).toMatchObject({ state: 'failed', level: 'strong' });
    expect(effects.status.notice).toMatch(/could not keep up/);
    // Until the user picks again, the camera goes out as it is.
    expect(await effects.apply(camera, 'strong')).toBe(camera);
  });

  it('turns blur off with a notice when the worker reports an error', async () => {
    const { effects, sessions, fallback } = setup();
    await effects.apply(fakeCamera(), 'light');
    sessions[0].emit('error', 'The graphics context was lost');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(effects.status.notice).toBe('Background blur stopped: The graphics context was lost.');
  });

  it('runs calls one after another, so the last level wins', async () => {
    const { effects, sessions } = setup();
    const camera = fakeCamera();
    const results = await Promise.all([effects.apply(camera, 'strong'), effects.apply(camera, 'off'), effects.apply(camera, 'light')]);
    expect(results[1]).toBe(camera);
    expect(results[2]).toBe(sessions[1].track);
    expect(sessions[0].closed).toBe(true);
    expect(effects.status).toMatchObject({ level: 'light', engine: 'device' });
  });

  it('stops everything when the camera goes off and starts the next camera from the top', async () => {
    const { effects, sessions } = setup();
    const camera = fakeCamera();
    await effects.apply(camera, 'strong');
    sessions[0].emit('model-ready', undefined);
    stepDown(sessions[0]);
    expect(sessions[0].tiers.at(-1)).toEqual({ level: 'strong', segmentEvery: 2 });
    effects.stop();
    expect(sessions[0].closed).toBe(true);
    expect(effects.status).toMatchObject({ state: 'off', level: 'strong' });
    await effects.apply(fakeCamera(), 'strong');
    expect(sessions[1].tiers[0]).toEqual({ level: 'strong', segmentEvery: 1 });
  });
});
