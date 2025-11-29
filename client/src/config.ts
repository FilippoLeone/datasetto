/**
 * Runtime Configuration
 * 
 * This module centralizes configuration loading.
 * It prioritizes runtime configuration (window.env) injected by Docker/deployment,
 * falling back to build-time configuration (import.meta.env) for development.
 */

// Helper to safely get env var
const getEnv = (key: string, fallback: string): string => {
  // 1. Runtime config (window.env) - Injected at container startup
  const runtimeEnv = window.env as Record<string, string> | undefined;
  if (runtimeEnv && runtimeEnv[key]) {
    return runtimeEnv[key];
  }
  // 2. Build-time config (import.meta.env) - Vite dev/build
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildEnv = import.meta.env as any;
  if (buildEnv[key]) {
    return buildEnv[key];
  }
  // 3. Fallback
  return fallback;
};

export const config = {
  // Server URLs
  SERVER_URL: getEnv('VITE_SERVER_URL', 'http://localhost:4000'),
  API_BASE_URL: getEnv('VITE_API_BASE_URL', 'http://localhost:4000'),
  HLS_BASE_URL: getEnv('VITE_HLS_BASE_URL', 'http://localhost/hls'),
  RTMP_SERVER_URL: getEnv('VITE_RTMP_SERVER_URL', 'rtmp://localhost/live'),

  // Mobile Defaults
  MOBILE_DEFAULT_SERVER_URL: getEnv('VITE_MOBILE_DEFAULT_SERVER_URL', 'https://datasetto.com'),
  MOBILE_DEFAULT_HLS_URL: getEnv('VITE_MOBILE_DEFAULT_HLS_URL', 'https://datasetto.com/hls'),
  MOBILE_DEFAULT_RTMP_URL: getEnv('VITE_MOBILE_DEFAULT_RTMP_URL', 'rtmp://datasetto.com/live'),

  // WebRTC / TURN
  WEBRTC_ICE_SERVERS: getEnv('VITE_WEBRTC_ICE_SERVERS', ''),
  TURN_URL: getEnv('VITE_TURN_URL', ''),
  TURN_USERNAME: getEnv('VITE_TURN_USERNAME', ''),
  TURN_CREDENTIAL: getEnv('VITE_TURN_CREDENTIAL', ''),

  // Voice Settings
  VOICE_OPUS_BITRATE: getEnv('VITE_VOICE_OPUS_BITRATE', '64000'),
  VOICE_DTX_ENABLED: getEnv('VITE_VOICE_DTX_ENABLED', 'true'),
  VOICE_OPUS_STEREO: getEnv('VITE_VOICE_OPUS_STEREO', 'false'),
  VOICE_OPUS_MIN_PTIME: getEnv('VITE_VOICE_OPUS_MIN_PTIME', '10'),
  VOICE_OPUS_MAX_PTIME: getEnv('VITE_VOICE_OPUS_MAX_PTIME', '20'),
  VOICE_OPUS_MAX_PLAYBACK_RATE: getEnv('VITE_VOICE_OPUS_MAX_PLAYBACK_RATE', '48000'),
  VOICE_VAD_THRESHOLD: getEnv('VITE_VOICE_VAD_THRESHOLD', '0.07'),
  NOISE_REDUCTION_LEVEL: getEnv('VITE_NOISE_REDUCTION_LEVEL', '0.35'),

  // Screenshare
  SCREENSHARE_IDEAL_WIDTH: getEnv('VITE_SCREENSHARE_IDEAL_WIDTH', '1920'),
  SCREENSHARE_IDEAL_HEIGHT: getEnv('VITE_SCREENSHARE_IDEAL_HEIGHT', '1080'),
  SCREENSHARE_IDEAL_FPS: getEnv('VITE_SCREENSHARE_IDEAL_FPS', '30'),
  SCREENSHARE_MAX_FPS: getEnv('VITE_SCREENSHARE_MAX_FPS', '60'),
  SCREENSHARE_MAX_BITRATE_KBPS: getEnv('VITE_SCREENSHARE_MAX_BITRATE_KBPS', '8000'),
};
