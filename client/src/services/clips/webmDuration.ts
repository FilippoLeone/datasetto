/**
 * MediaRecorder writes WebM for a live stream: the Segment has an unknown size and
 * the Info element carries no Duration, so players show the file as endless until
 * they have scanned it (the seek bar of the clips panel would be useless, and some
 * players refuse to seek at all). This patches the Duration we know into the file.
 *
 * Only the head of the file (everything before the first Cluster) is rewritten; the
 * clusters themselves are passed through untouched, so the work is a few kilobytes
 * however long the clip is.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_CLUSTER = 0x1f43b675;

/** Default TimecodeScale of Matroska: one millisecond per timecode unit. */
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;

/** How much of the file is read to find the first Cluster. The head is normally under a few KB. */
const HEAD_READ_BYTES = 512 * 1024;

interface Element {
  id: number;
  /** Offset of the element id. */
  start: number;
  /** Offset of the first data byte. */
  dataStart: number;
  /** Data size, or -1 for an unknown size. */
  size: number;
  /** Offset just past the element (for unknown sizes: past its header). */
  end: number;
}

/** An element id as it appears in the file: a vint whose marker bit is kept. */
const readId = (bytes: Uint8Array, offset: number): { id: number; length: number } | null => {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && !(first & mask)) {
    mask >>= 1;
    length += 1;
  }
  if (length > 4 || offset + length > bytes.length) return null;
  let id = 0;
  for (let index = 0; index < length; index += 1) id = id * 256 + bytes[offset + index];
  return { id, length };
};

/** A data size: a vint with the marker bit removed; all value bits set means "unknown". */
const readSize = (bytes: Uint8Array, offset: number): { size: number; length: number } | null => {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > bytes.length) return null;
  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[offset + index];
    if (byte !== 0xff) allOnes = false;
    value = value * 256 + byte;
  }
  return { size: allOnes ? -1 : value, length };
};

const readElement = (bytes: Uint8Array, offset: number): Element | null => {
  const id = readId(bytes, offset);
  if (!id) return null;
  const size = readSize(bytes, offset + id.length);
  if (!size) return null;
  const dataStart = offset + id.length + size.length;
  return { id: id.id, start: offset, dataStart, size: size.size, end: size.size < 0 ? dataStart : dataStart + size.size };
};

/** A size vint of exactly `length` bytes. */
export const encodeSize = (size: number, length: number): Uint8Array => {
  const out = new Uint8Array(length);
  let remaining = size;
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
};

/** The shortest vint that holds `size`. */
const sizeLength = (size: number): number => {
  let length = 1;
  // Each extra byte adds 7 bits of value; the all-ones pattern is reserved for "unknown".
  while (length < 8 && size >= 2 ** (7 * length) - 1) length += 1;
  return length;
};

const encodeId = (id: number): Uint8Array => {
  const bytes: number[] = [];
  let remaining = id;
  while (remaining > 0) {
    bytes.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return new Uint8Array(bytes);
};

const readUint = (bytes: Uint8Array, start: number, size: number): number => {
  let value = 0;
  for (let index = 0; index < size; index += 1) value = value * 256 + bytes[start + index];
  return value;
};

const concat = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export interface PatchedHead {
  /** The rewritten bytes up to (not including) the first Cluster. */
  head: Uint8Array<ArrayBuffer>;
  /** Where the untouched remainder of the original file begins. */
  tailOffset: number;
}

/**
 * Write `durationMs` into the Info element of a WebM head. Returns null when the
 * head is not a WebM file we understand (then the file is left as it was).
 */
export const patchWebmHead = (bytes: Uint8Array, durationMs: number): PatchedHead | null => {
  const ebml = readElement(bytes, 0);
  if (!ebml || ebml.id !== ID_EBML || ebml.size < 0) return null;
  const segment = readElement(bytes, ebml.end);
  if (!segment || segment.id !== ID_SEGMENT) return null;

  let info: Element | null = null;
  let clusterStart = -1;
  let offset = segment.dataStart;
  while (offset < bytes.length) {
    const element = readElement(bytes, offset);
    if (!element) return null;
    if (element.id === ID_CLUSTER) {
      clusterStart = element.start;
      break;
    }
    if (element.id === ID_INFO) info = element;
    if (element.size < 0) return null;
    offset = element.end;
  }
  if (!info || clusterStart < 0) return null;

  // Inside Info: the timecode scale, and a Duration if the writer already left one.
  let timecodeScale = DEFAULT_TIMECODE_SCALE_NS;
  let duration: Element | null = null;
  offset = info.dataStart;
  while (offset < info.end) {
    const child = readElement(bytes, offset);
    if (!child || child.size < 0) return null;
    if (child.id === ID_TIMECODE_SCALE) timecodeScale = readUint(bytes, child.dataStart, child.size) || DEFAULT_TIMECODE_SCALE_NS;
    if (child.id === ID_DURATION) duration = child;
    offset = child.end;
  }
  const durationTicks = (durationMs * 1_000_000) / timecodeScale;

  if (duration && (duration.size === 8 || duration.size === 4)) {
    const head = bytes.slice(0, clusterStart);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (duration.size === 8) view.setFloat64(duration.dataStart, durationTicks);
    else view.setFloat32(duration.dataStart, durationTicks);
    return { head, tailOffset: clusterStart };
  }

  // No Duration yet: append one to Info and grow Info's size. The Segment keeps its
  // unknown size; a Segment with a known size grows by the same amount.
  const durationElement = new Uint8Array(2 + 1 + 8);
  durationElement.set(encodeId(ID_DURATION), 0);
  durationElement[2] = 0x88;
  new DataView(durationElement.buffer).setFloat64(3, durationTicks);

  const infoChildren = bytes.subarray(info.dataStart, info.end);
  const newInfoSize = infoChildren.length + durationElement.length;
  const oldInfoSizeLength = info.dataStart - info.start - encodeId(ID_INFO).length;
  const newInfoSizeLength = Math.max(oldInfoSizeLength, sizeLength(newInfoSize));
  const newInfo = concat([encodeId(ID_INFO), encodeSize(newInfoSize, newInfoSizeLength), infoChildren, durationElement]);
  const grownBy = newInfo.length - (info.end - info.start);

  let segmentHeader = bytes.subarray(segment.start, segment.dataStart);
  if (segment.size >= 0) {
    const segmentSizeLength = segment.dataStart - segment.start - encodeId(ID_SEGMENT).length;
    const newSegmentSize = segment.size + grownBy;
    if (sizeLength(newSegmentSize) > segmentSizeLength) return null;
    segmentHeader = concat([encodeId(ID_SEGMENT), encodeSize(newSegmentSize, segmentSizeLength)]);
  }

  const head = concat([
    bytes.subarray(0, segment.start),
    segmentHeader,
    bytes.subarray(segment.dataStart, info.start),
    newInfo,
    bytes.subarray(info.end, clusterStart),
  ]);
  return { head, tailOffset: clusterStart };
};

/**
 * The recorded blob with its Duration set, or the blob itself when the head could
 * not be patched. Reads only the head of the file.
 */
export const fixWebmDuration = async (blob: Blob, durationMs: number): Promise<Blob> => {
  if (!/webm|matroska/i.test(blob.type) || durationMs <= 0) return blob;
  try {
    const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, HEAD_READ_BYTES)).arrayBuffer());
    const patched = patchWebmHead(head, durationMs);
    if (!patched) return blob;
    return new Blob([patched.head, blob.slice(patched.tailOffset)], { type: blob.type });
  } catch {
    return blob;
  }
};

/** Test helper and building block: one EBML element from its id and payload. */
export const ebmlElement = (id: number, payload: Uint8Array, unknownSize = false): Uint8Array<ArrayBuffer> =>
  concat([encodeId(id), unknownSize ? new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : encodeSize(payload.length, sizeLength(payload.length)), payload]);

/** Reads the Duration (in milliseconds) a WebM head declares, for tests and the clips panel; null when absent. */
export const readWebmDuration = (bytes: Uint8Array): number | null => {
  const ebml = readElement(bytes, 0);
  if (!ebml || ebml.id !== ID_EBML) return null;
  const segment = readElement(bytes, ebml.end);
  if (!segment || segment.id !== ID_SEGMENT) return null;
  let offset = segment.dataStart;
  while (offset < bytes.length) {
    const element = readElement(bytes, offset);
    if (!element || element.id === ID_CLUSTER) return null;
    if (element.id === ID_INFO) {
      let timecodeScale = DEFAULT_TIMECODE_SCALE_NS;
      let duration: number | null = null;
      let inner = element.dataStart;
      while (inner < element.end) {
        const child = readElement(bytes, inner);
        if (!child || child.size < 0) return null;
        if (child.id === ID_TIMECODE_SCALE) timecodeScale = readUint(bytes, child.dataStart, child.size) || DEFAULT_TIMECODE_SCALE_NS;
        if (child.id === ID_DURATION) {
          const view = new DataView(bytes.buffer, bytes.byteOffset + child.dataStart, child.size);
          duration = child.size === 8 ? view.getFloat64(0) : child.size === 4 ? view.getFloat32(0) : null;
        }
        inner = child.end;
      }
      return duration === null ? null : (duration * timecodeScale) / 1_000_000;
    }
    if (element.size < 0) return null;
    offset = element.end;
  }
  return null;
};

export const WEBM_IDS = { EBML: ID_EBML, SEGMENT: ID_SEGMENT, INFO: ID_INFO, TIMECODE_SCALE: ID_TIMECODE_SCALE, DURATION: ID_DURATION, CLUSTER: ID_CLUSTER } as const;
