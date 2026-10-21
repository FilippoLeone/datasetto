import { describe, expect, it } from 'vitest';
import { ebmlElement, encodeSize, fixWebmDuration, patchWebmHead, readWebmDuration, WEBM_IDS } from './webmDuration';

const uint = (value: number, bytes: number): Uint8Array => {
  const out = new Uint8Array(bytes);
  for (let index = bytes - 1; index >= 0; index -= 1) {
    out[index] = value % 256;
    value = Math.floor(value / 256);
  }
  return out;
};

const float64 = (value: number): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
};

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const ID_TRACKS = 0x1654ae6b;
const ID_MUXING_APP = 0x4d80;

/** A WebM head the way Chrome's recorder writes it: Segment of unknown size, Info without Duration. */
const liveWebm = (options: { timecodeScale?: number; withDuration?: number; knownSegmentSize?: boolean } = {}): Uint8Array<ArrayBuffer> => {
  const ebmlHeader = ebmlElement(WEBM_IDS.EBML, concat(ebmlElement(0x4286, uint(1, 1)), ebmlElement(0x4282, new TextEncoder().encode('webm'))));
  const infoChildren = [ebmlElement(WEBM_IDS.TIMECODE_SCALE, uint(options.timecodeScale ?? 1_000_000, 3)), ebmlElement(ID_MUXING_APP, new TextEncoder().encode('Chrome'))];
  if (options.withDuration !== undefined) infoChildren.push(ebmlElement(WEBM_IDS.DURATION, float64(options.withDuration)));
  const info = ebmlElement(WEBM_IDS.INFO, concat(...infoChildren));
  const tracks = ebmlElement(ID_TRACKS, new Uint8Array([0xae, 0x81, 0x00]));
  const cluster = ebmlElement(WEBM_IDS.CLUSTER, concat(ebmlElement(0xe7, uint(0, 1)), new Uint8Array([0xa3, 0x83, 0x81, 0x00, 0x80])));
  const body = concat(info, tracks, cluster);
  const segment = ebmlElement(WEBM_IDS.SEGMENT, body, !options.knownSegmentSize);
  return concat(ebmlHeader, segment);
};

describe('patchWebmHead', () => {
  it('adds a Duration to an Info that has none and leaves the clusters untouched', () => {
    const file = liveWebm();
    expect(readWebmDuration(file)).toBeNull();
    const patched = patchWebmHead(file, 27_500);
    expect(patched).not.toBeNull();
    const result = concat(patched!.head, file.subarray(patched!.tailOffset));
    expect(readWebmDuration(result)).toBeCloseTo(27_500);
    // The tail starts at the Cluster id and is byte-identical to the original's.
    const clusterStart = file.length - file.subarray(patched!.tailOffset).length;
    expect(Array.from(file.subarray(clusterStart, clusterStart + 4))).toEqual([0x1f, 0x43, 0xb6, 0x75]);
    expect(result.length).toBe(file.length + 11);
  });

  it('overwrites an existing Duration in place', () => {
    const file = liveWebm({ withDuration: 1 });
    const patched = patchWebmHead(file, 12_345);
    expect(patched!.head.length).toBe(patched!.tailOffset);
    const result = concat(patched!.head, file.subarray(patched!.tailOffset));
    expect(result.length).toBe(file.length);
    expect(readWebmDuration(result)).toBeCloseTo(12_345);
  });

  it('respects the TimecodeScale and grows a Segment of known size', () => {
    const file = liveWebm({ timecodeScale: 500_000, knownSegmentSize: true });
    const patched = patchWebmHead(file, 10_000)!;
    const result = concat(patched.head, file.subarray(patched.tailOffset));
    expect(readWebmDuration(result)).toBeCloseTo(10_000);
    // The Duration element itself holds the value in timecode units: 10 s at 0.5 ms per tick = 20000 ticks.
    const durationOffset = result.findIndex((_, index) => result[index] === 0x44 && result[index + 1] === 0x89 && result[index + 2] === 0x88);
    expect(new DataView(result.buffer, result.byteOffset + durationOffset + 3, 8).getFloat64(0)).toBe(20_000);
  });

  it('refuses anything that is not a WebM head', () => {
    expect(patchWebmHead(new Uint8Array([1, 2, 3, 4]), 1000)).toBeNull();
    expect(patchWebmHead(new TextEncoder().encode('ftypisom'), 1000)).toBeNull();
    // A head cut before the first Cluster cannot be patched safely.
    const file = liveWebm();
    expect(patchWebmHead(file.subarray(0, file.length - 12), 1000)).toBeNull();
  });

  it('encodes sizes as vints of the asked length', () => {
    expect(Array.from(encodeSize(5, 1))).toEqual([0x85]);
    expect(Array.from(encodeSize(300, 2))).toEqual([0x41, 0x2c]);
    expect(Array.from(encodeSize(0, 8))).toEqual([0x01, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('fixWebmDuration', () => {
  it('returns a patched blob of the same type and passes other blobs through', async () => {
    const file = liveWebm();
    const blob = new Blob([file], { type: 'video/webm;codecs=vp9,opus' });
    const fixed = await fixWebmDuration(blob, 5_000);
    expect(fixed.type).toBe('video/webm;codecs=vp9,opus');
    expect(fixed.size).toBe(blob.size + 11);
    expect(readWebmDuration(new Uint8Array(await fixed.arrayBuffer()))).toBeCloseTo(5_000);

    const mp4 = new Blob([new Uint8Array([0, 0, 0, 1])], { type: 'video/mp4' });
    expect(await fixWebmDuration(mp4, 5_000)).toBe(mp4);
    expect(await fixWebmDuration(blob, 0)).toBe(blob);
  });
});
