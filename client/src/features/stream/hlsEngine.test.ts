import { describe, expect, it } from 'vitest';
import { pickHlsEngine } from './hlsEngine';

describe('pickHlsEngine', () => {
  it('uses hls.js wherever Media Source Extensions exist (desktop browsers, Android)', () => {
    expect(pickHlsEngine({ ios: false, nativeHls: false, mse: true })).toBe('hls.js');
    // Desktop Safari has both; hls.js keeps the ticket header and the low latency.
    expect(pickHlsEngine({ ios: false, nativeHls: true, mse: true })).toBe('hls.js');
  });

  it('plays natively on iPhone and iPad, where the system player and background playback live', () => {
    expect(pickHlsEngine({ ios: true, nativeHls: true, mse: false })).toBe('native');
    // iOS 17.1+ exposes ManagedMediaSource: the native player is still the better fit there.
    expect(pickHlsEngine({ ios: true, nativeHls: true, mse: true })).toBe('native');
  });

  it('falls back to the native element when hls.js cannot run, and gives up when nothing can', () => {
    expect(pickHlsEngine({ ios: false, nativeHls: true, mse: false })).toBe('native');
    expect(pickHlsEngine({ ios: true, nativeHls: false, mse: false })).toBe('none');
    expect(pickHlsEngine({ ios: false, nativeHls: false, mse: false })).toBe('none');
  });
});
