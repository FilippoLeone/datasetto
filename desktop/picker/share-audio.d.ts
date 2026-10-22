/** Types for share-audio.js (CommonJS); the client's unit tests load the module through createRequire. */

export interface OwnAudioExclusion {
  /** True when Chromium can leave this app's own playback out of system audio. */
  supported: boolean;
  platform: string;
}

export interface PickedSource {
  id: string;
  name?: string;
}

export interface Grant {
  source: { id: string; name: string };
  shareAudio: boolean;
}

export interface GrantStore {
  arm(webContentsId: number, source: PickedSource | null | undefined, shareAudio: boolean): boolean;
  take(webContentsId: number | undefined): Grant | null;
  clear(): void;
}

export interface DisplayMediaAnswer {
  video: { id: string; name: string };
  audio?: 'loopback';
}

export const GRANT_TTL_MS: number;
export const GRANT_MAX_USES: number;
export function ownAudioExclusion(platform: string, version: string | undefined): OwnAudioExclusion;
export function shareAudioHint(exclusion: OwnAudioExclusion | null | undefined): string;
export function createGrantStore(now?: () => number): GrantStore;
export function displayMediaAnswer(request: { audioRequested?: boolean } | null | undefined, grant: Grant): DisplayMediaAnswer;
export function describeAnswer(answer: DisplayMediaAnswer, exclusion: OwnAudioExclusion | null | undefined): string;
