import { effect } from '@preact/signals';
import { describe, expect, it } from 'vitest';
import { MIC_LEVEL_STEP, micLevel, resetVoiceState } from './voice';

/** One second of mic samples at 20 a second (the AudioService rate). */
const second = (sample: (index: number) => number) => Array.from({ length: 20 }, (_, index) => sample(index));

describe('micLevel', () => {
  it('takes no writes while no meter shows it', () => {
    for (const level of second((i) => 0.1 + i / 40)) micLevel.value = level;
    expect(micLevel.peek()).toBe(0);
    resetVoiceState();
    expect(micLevel.peek()).toBe(0);
  });

  it('with a meter: at most 20 writes a second, only for changes the meter can show', () => {
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(micLevel.value);
    });
    seen.length = 0; // the effect's first run

    // A steady level with jitter below the meter's step: one write.
    for (const level of second((i) => 0.3 + (i % 2) * MIC_LEVEL_STEP * 0.5)) micLevel.value = level;
    expect(seen).toEqual([0.3]);

    // Speech: every sample moves the meter.
    seen.length = 0;
    for (const level of second((i) => (i % 2 === 0 ? 0.1 : 0.4))) micLevel.value = level;
    expect(seen).toHaveLength(20);

    // Silence always gets through, so the meter drops to zero.
    seen.length = 0;
    micLevel.value = 0.004;
    micLevel.value = 0;
    expect(seen).toEqual([0.004, 0]);

    // The meter closes: the level resets and later samples are dropped.
    micLevel.value = 0.5;
    stop();
    expect(micLevel.peek()).toBe(0);
    for (const level of second(() => 0.6)) micLevel.value = level;
    expect(micLevel.peek()).toBe(0);
  });

  it('starts a newly opened meter from silence', () => {
    const first = effect(() => void micLevel.value);
    micLevel.value = 0.7;
    first();
    const seen: number[] = [];
    const again = effect(() => {
      seen.push(micLevel.value);
    });
    expect(seen).toEqual([0]);
    again();
  });
});
