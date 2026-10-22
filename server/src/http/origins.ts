import type { AppConfig } from '../config.js';

const normalize = (origin: string): string => origin.replace(/\/+$/, '').toLowerCase();

/**
 * Decide whether a browser Origin may talk to us. Non-browser clients send no
 * Origin and are allowed; native shells (Electron, Capacitor) are allowed when
 * `allowNativeOrigins` is on because they use file:// and localhost origins.
 */
export const createOriginChecker = (cors: AppConfig['cors']): ((origin: string | undefined) => boolean) => {
  const allowed = new Set(cors.origins.map(normalize));
  const allowAll = allowed.has('*');

  return (origin) => {
    if (!origin) return true;
    if (allowAll) return true;
    const normalized = normalize(origin);
    if (allowed.has(normalized)) return true;

    if (cors.allowNativeOrigins) {
      // Tested on the raw origin: normalizing would turn Electron's `file://` into `file:`.
      const raw = origin.toLowerCase();
      if (raw === 'null' || raw === 'file:' || raw.startsWith('file://')) return true;
      if (/^(capacitor|ionic|electron|app):\/\//.test(raw)) return true;
      if (/^https?:\/\/localhost(:\d+)?$/.test(normalized)) return true;
      if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(normalized)) return true;
    }
    return false;
  };
};
