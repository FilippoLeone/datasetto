/**
 * Just enough EBML to tell a WebM file from anything else and to read what the chat
 * needs about it: the picture size of its video track and its duration. Only the
 * head of the file (everything before the first Cluster) is looked at, so the work
 * is a few kilobytes however long the clip is.
 */

const ID_EBML = 0x1a45dfa3;
const ID_DOCTYPE = 0x4282;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_TYPE = 0x83;
const ID_VIDEO = 0xe0;
const ID_PIXEL_WIDTH = 0xb0;
const ID_PIXEL_HEIGHT = 0xba;
const ID_CLUSTER = 0x1f43b675;
const TRACK_TYPE_VIDEO = 1;

/** Default TimecodeScale of Matroska: one millisecond per timecode unit. */
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;

/** How much of a file is scanned for its head; a recorded WebM's head is well under this. */
export const WEBM_HEAD_BYTES = 1024 * 1024;

interface Element {
  id: number;
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
  return { id: id.id, dataStart, size: size.size, end: size.size < 0 ? dataStart : dataStart + size.size };
};

const readUint = (bytes: Uint8Array, element: Element): number => {
  let value = 0;
  for (let index = 0; index < element.size; index += 1) value = value * 256 + bytes[element.dataStart + index];
  return value;
};

const readFloat = (bytes: Uint8Array, element: Element): number | null => {
  if (element.end > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + element.dataStart, element.size);
  return element.size === 8 ? view.getFloat64(0) : element.size === 4 ? view.getFloat32(0) : null;
};

/** The children of an element that fit in the buffer, in order; stops at the first unreadable one. */
const children = (bytes: Uint8Array, parent: Element): Element[] => {
  const out: Element[] = [];
  let offset = parent.dataStart;
  const end = Math.min(parent.end, bytes.length);
  while (offset < end) {
    const child = readElement(bytes, offset);
    if (!child || child.size < 0 || child.end > bytes.length) break;
    out.push(child);
    offset = child.end;
  }
  return out;
};

/** Is this a WebM file? The EBML magic and a DocType of "webm" (Matroska files say "matroska"). */
export const isWebm = (bytes: Uint8Array): boolean => {
  const ebml = readElement(bytes, 0);
  if (!ebml || ebml.id !== ID_EBML || ebml.size < 0) return false;
  const docType = children(bytes, ebml).find((child) => child.id === ID_DOCTYPE);
  if (!docType) return false;
  let value = '';
  for (let index = docType.dataStart; index < docType.end; index += 1) value += String.fromCharCode(bytes[index]);
  return value.replace(/\0+$/, '') === 'webm';
};

export interface WebmInfo {
  /** Picture size of the video track, when the header says. */
  width: number | null;
  height: number | null;
  /** From the header's Duration; null for a live recording that never got one. */
  durationMs: number | null;
}

/**
 * What the head of a WebM says about its video: null when the file is not WebM,
 * its head cannot be read, or it has no video track (an audio-only recording).
 */
export const readWebmInfo = (bytes: Uint8Array): WebmInfo | null => {
  if (!isWebm(bytes)) return null;
  const ebml = readElement(bytes, 0) as Element;
  const segment = readElement(bytes, ebml.end);
  if (!segment || segment.id !== ID_SEGMENT) return null;

  let width: number | null = null;
  let height: number | null = null;
  let durationMs: number | null = null;
  let hasVideo = false;
  let offset = segment.dataStart;
  while (offset < bytes.length) {
    const element = readElement(bytes, offset);
    // The Cluster marks the end of the head; a truncated element means the head read stopped short.
    if (!element || element.id === ID_CLUSTER || element.size < 0 || element.end > bytes.length) break;
    if (element.id === ID_INFO) {
      let timecodeScale = DEFAULT_TIMECODE_SCALE_NS;
      let duration: number | null = null;
      for (const child of children(bytes, element)) {
        if (child.id === ID_TIMECODE_SCALE) timecodeScale = readUint(bytes, child) || DEFAULT_TIMECODE_SCALE_NS;
        if (child.id === ID_DURATION) duration = readFloat(bytes, child);
      }
      if (duration !== null && Number.isFinite(duration) && duration > 0) durationMs = (duration * timecodeScale) / 1_000_000;
    } else if (element.id === ID_TRACKS) {
      for (const entry of children(bytes, element)) {
        if (entry.id !== ID_TRACK_ENTRY) continue;
        const fields = children(bytes, entry);
        const type = fields.find((field) => field.id === ID_TRACK_TYPE);
        const video = fields.find((field) => field.id === ID_VIDEO);
        if ((type && readUint(bytes, type) !== TRACK_TYPE_VIDEO) || !video) continue;
        hasVideo = true;
        for (const field of children(bytes, video)) {
          if (field.id === ID_PIXEL_WIDTH) width = readUint(bytes, field) || null;
          if (field.id === ID_PIXEL_HEIGHT) height = readUint(bytes, field) || null;
        }
      }
    }
    offset = element.end;
  }
  if (!hasVideo) return null;
  return { width, height, durationMs };
};
