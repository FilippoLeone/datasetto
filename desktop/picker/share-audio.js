'use strict';

/**
 * Sound in a desktop screen share. System audio is a loopback of everything the
 * computer plays, which includes Datasetto's own playback (friends' voices, alert
 * sounds, a stream being watched), so viewers would hear themselves echoed back.
 *
 * Electron 44 (Chromium 152) can leave our own process tree out, but only on the
 * getDisplayMedia() route: when the page asks with `restrictOwnAudio: true` and
 * setDisplayMediaRequestHandler answers `audio: 'loopback'`, Electron swaps in
 * Chromium's "loopbackWithoutChrome" device. On Windows 11 that is WASAPI process
 * loopback excluding the audio service's process tree; on macOS 14.2+ a CoreAudio
 * tap excluding it. All of Datasetto's sound plays through that audio service.
 * The legacy getUserMedia({ chromeMediaSource: 'desktop' }) route always captures
 * plain "loopback" and cannot exclude anything.
 *
 * The picker runs first (it is our own window), then the page calls
 * getDisplayMedia(); the grant below carries the picked source across.
 *
 * No Electron in here, so the client's unit tests load this file as it is.
 */

/** Chromium treats build 22000 and later as Windows 11 (base::win::Version::WIN11). */
const WINDOWS_11_BUILD = 22000;

/** A picked source stays usable for this long, and for this many requests (one retry without audio, one spare). */
const GRANT_TTL_MS = 30_000;
const GRANT_MAX_USES = 3;

const SOURCE_ID = /^(screen|window):[\w:-]+$/;

/**
 * Whether Chromium can leave this app's own playback out of system audio here.
 * Mirrors media::IsRestrictOwnAudioSupported() in Chromium 152: Windows 11, or
 * macOS 14.2 and later (CoreAudio taps). Nothing on Linux.
 *
 * @param {string} platform process.platform
 * @param {string} version os.release() on Windows ("10.0.26100"), process.getSystemVersion() on macOS ("14.2.1")
 */
function ownAudioExclusion(platform, version) {
  const parts = String(version ?? '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  if (platform === 'win32') {
    const build = parts[2];
    return { supported: Number.isFinite(build) && build >= WINDOWS_11_BUILD, platform };
  }
  if (platform === 'darwin') {
    const [major, minor = 0] = parts;
    const supported = Number.isFinite(major) && (major > 14 || (major === 14 && minor >= 2));
    return { supported, platform };
  }
  return { supported: false, platform };
}

/** The picker's one-line explanation under "Share system audio". */
function shareAudioHint(exclusion) {
  if (exclusion?.supported) {
    return 'Sends everything your computer plays (game sound, music), not just the picked window, but never Datasetto itself: nobody hears their own voice back.';
  }
  switch (exclusion?.platform) {
    case 'win32':
      return 'Windows 10 cannot leave Datasetto out of system audio, so your friends may hear themselves echoed back. Windows 11 can.';
    case 'darwin':
      return 'This macOS version cannot leave Datasetto out of system audio, so your friends may hear themselves echoed back. macOS 14.2 or later can.';
    default:
      return 'Linux cannot leave Datasetto out of system audio, so your friends may hear themselves echoed back.';
  }
}

/**
 * Hand-over from the picker to the getDisplayMedia() request that follows it, bound
 * to the WebContents that opened the picker and short-lived.
 */
function createGrantStore(now = Date.now) {
  let grant = null;
  return {
    /** Remember a picked source; returns false (and keeps nothing) for anything that is not a screen or window id. */
    arm(webContentsId, source, shareAudio) {
      grant = null;
      if (!source || typeof source.id !== 'string' || !SOURCE_ID.test(source.id)) return false;
      grant = {
        webContentsId,
        source: { id: source.id, name: typeof source.name === 'string' && source.name ? source.name : 'Screen' },
        shareAudio: Boolean(shareAudio),
        expiresAt: now() + GRANT_TTL_MS,
        usesLeft: GRANT_MAX_USES,
      };
      return true;
    },
    /** The grant for this WebContents, or null when there is none, it expired or it was used up. */
    take(webContentsId) {
      if (!grant) return null;
      if (now() > grant.expiresAt) {
        grant = null;
        return null;
      }
      if (grant.webContentsId !== webContentsId) return null;
      grant.usesLeft -= 1;
      const taken = { source: { ...grant.source }, shareAudio: grant.shareAudio };
      if (grant.usesLeft <= 0) grant = null;
      return taken;
    },
    clear() {
      grant = null;
    },
  };
}

/**
 * The `streams` object for setDisplayMediaRequestHandler's callback. Audio is only
 * granted when the page asked for it and the user left "Share system audio" on.
 */
function displayMediaAnswer(request, grant) {
  const answer = { video: { id: grant.source.id, name: grant.source.name } };
  if (request?.audioRequested && grant.shareAudio) {
    // Electron replaces this with "loopbackWithoutChrome" when the page asked with
    // restrictOwnAudio and the OS supports it (see the top of this file).
    answer.audio = 'loopback';
  }
  return answer;
}

/** What the log records about a grant: the kind of source and the audio mode, never window titles. */
function describeAnswer(answer, exclusion) {
  const kind = answer.video.id.startsWith('screen:') ? 'screen' : 'window';
  if (!answer.audio) return kind + ', no audio';
  return kind + ', audio ' + answer.audio + (exclusion?.supported ? ' (own audio excluded when the page asks)' : ' (this OS cannot exclude own audio)');
}

module.exports = {
  GRANT_TTL_MS,
  GRANT_MAX_USES,
  ownAudioExclusion,
  shareAudioHint,
  createGrantStore,
  displayMediaAnswer,
  describeAnswer,
};
