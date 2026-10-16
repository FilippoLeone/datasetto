/**
 * Release version comparison for the update notices. Versions look like
 * `0.1.12`, `v0.1.12`, `1.2.0-beta.1` or `0.1.12-2-gabc123` (git describe).
 *
 * A pre-release suffix (`-beta.1`) sorts below the plain release. A git describe
 * suffix (`-2-gabc123`: two commits after the tag) means "that release plus N
 * commits", so `0.1.12-2-gabc123` is newer than `0.1.12` and older than `0.1.13`;
 * a web bundle built from a commit after the latest release is then current.
 */
export interface ParsedVersion {
  /** `[major, minor, patch, ...]`, missing parts are 0. */
  numbers: number[];
  /** `beta.1` in `1.2.0-beta.1`; empty for a plain release. */
  prerelease: string;
  /** Commits after the tag in a git describe version (`2` in `0.1.12-2-gabc123`); 0 for a release. */
  commits: number;
}

const NUMBERS = /^v?(\d+(?:\.\d+)*)(?:[-+](.*))?$/i;
/** The `-<commits>-g<hash>` tail `git describe` adds when the commit is past the tag. */
const DESCRIBE = /^(.+)-(\d+)-g[0-9a-f]{4,}$/i;

export const parseVersion = (value: string | null | undefined): ParsedVersion | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const described = DESCRIBE.exec(trimmed);
  const match = NUMBERS.exec(described ? described[1] : trimmed);
  if (!match) return null;
  return {
    numbers: match[1].split('.').map((part) => Number(part)),
    prerelease: (match[2] ?? '').trim(),
    commits: described ? Number(described[2]) : 0,
  };
};

const comparePrerelease = (a: string, b: string): number => {
  if (a === b) return 0;
  // A plain release is newer than any pre-release of the same numbers.
  if (!a) return 1;
  if (!b) return -1;
  const left = a.split('.');
  const right = b.split('.');
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. Unparseable input counts as the oldest. */
export const compareVersions = (a: string | null | undefined, b: string | null | undefined): number => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  const prerelease = comparePrerelease(left.prerelease, right.prerelease);
  if (prerelease !== 0) return prerelease;
  // Same tag: the build with more commits after it is the newer one.
  if (left.commits !== right.commits) return left.commits < right.commits ? -1 : 1;
  return 0;
};

/** True when `candidate` is a valid version strictly newer than the (valid) `current` one. */
export const isNewerVersion = (candidate: string | null | undefined, current: string | null | undefined): boolean => {
  if (!parseVersion(candidate) || !parseVersion(current)) return false;
  return compareVersions(candidate, current) > 0;
};
