import { createHash, randomBytes, randomInt } from 'node:crypto';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const STREAM_KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const randomString = (alphabet: string, length: number): string => {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
};

/** Short URL-safe identifier with a type prefix, e.g. `channel-k3j...`. */
export const newId = (prefix: string, length = 16): string => prefix + '-' + randomString(ID_ALPHABET, length);

/** Opaque bearer token for sessions (base64url, 256 bits of entropy by default). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export const generateStreamKeyToken = (length = 24): string => randomString(STREAM_KEY_ALPHABET, length);

/**
 * Stream key as shown to streamers: `channel?key=token`. nginx-rtmp publishes the
 * stream under `channel` and passes `key` to the publish callback, so HLS URLs never
 * contain the secret.
 */
export const formatStreamKey = (channelName: string, token: string): string => channelName + '?key=' + token;

/**
 * Extract the secret token from whatever OBS sent as the stream name:
 * `channel+token`, `channel?key=token`, or the bare token.
 */
export const extractStreamKeyToken = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';

  const queryIndex = trimmed.indexOf('?');
  if (queryIndex !== -1) {
    const params = new URLSearchParams(trimmed.slice(queryIndex + 1));
    const keyParam = params.get('key') ?? params.get('token') ?? params.get('k');
    if (keyParam && keyParam.trim()) return keyParam.trim();
  }

  const base = queryIndex === -1 ? trimmed : trimmed.slice(0, queryIndex);
  const plusIndex = base.indexOf('+');
  if (plusIndex !== -1 && plusIndex < base.length - 1) {
    return base.slice(plusIndex + 1).trim();
  }
  return base;
};

/** Channel part of a stream name (`channel+token` becomes `channel`). */
export const extractStreamChannelName = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  let base = value.trim();
  const q = base.indexOf('?');
  if (q !== -1) base = base.slice(0, q);
  const plus = base.indexOf('+');
  if (plus !== -1) base = base.slice(0, plus);
  return base.trim();
};
