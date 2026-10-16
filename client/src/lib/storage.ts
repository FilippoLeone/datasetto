/** localStorage with JSON (de)serialisation that never throws. */
export const Storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota exceeded or storage disabled */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
