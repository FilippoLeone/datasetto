/**
 * Which player runs an HLS stream, kept free of the DOM so it can be unit tested.
 *
 * hls.js (Media Source Extensions) is the default: it can send the viewer ticket as a
 * request header and keeps the latency low. Safari on iPhone has no MSE for pages (and
 * the ManagedMediaSource of iOS 17.1+ needs AirPlay switched off), but its <video> plays
 * HLS natively, with the system player for fullscreen and playback that continues with
 * the screen locked. There the native path wins and the ticket travels in the cookie the
 * server set along with it.
 */
export type HlsEngine = 'hls.js' | 'native' | 'none';

export interface HlsEngineInput {
  /** iPhone or iPad (lib/device.ts). */
  ios: boolean;
  /** `video.canPlayType('application/vnd.apple.mpegurl')` said yes. */
  nativeHls: boolean;
  /** `Hls.isSupported()`: Media Source Extensions are available to hls.js. */
  mse: boolean;
}

export const pickHlsEngine = ({ ios, nativeHls, mse }: HlsEngineInput): HlsEngine => {
  if (ios && nativeHls) return 'native';
  if (mse) return 'hls.js';
  if (nativeHls) return 'native';
  return 'none';
};
