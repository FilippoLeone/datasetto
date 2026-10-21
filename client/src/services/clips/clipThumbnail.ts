/** A still of a live stream for the clips library, and the picture's size. */
export interface ThumbnailResult {
  blob: Blob | null;
  width: number;
  height: number;
}

const WAIT_MS = 1500;

const trackSize = (stream: MediaStream): { width: number; height: number } => {
  const settings = stream.getVideoTracks()[0]?.getSettings() ?? {};
  return { width: settings.width ?? 0, height: settings.height ?? 0 };
};

/**
 * Renders the stream's current frame into a JPEG no wider than `maxWidth`. A
 * detached <video> shows the stream for a moment; nothing is left in the page.
 * Resolves with no blob when the engine cannot paint the frame in time.
 */
export const captureThumbnail = async (stream: MediaStream, maxWidth = 320): Promise<ThumbnailResult> => {
  const fallback = trackSize(stream);
  if (typeof document === 'undefined' || stream.getVideoTracks().length === 0) return { blob: null, ...fallback };
  const video = document.createElement('video') as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, WAIT_MS);
      const painted = () => {
        window.clearTimeout(timer);
        resolve();
      };
      // A frame callback is a painted frame; loadeddata is the fallback where there is none.
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(painted);
      else video.addEventListener('loadeddata', painted, { once: true });
      video.play().catch(() => undefined);
    });
    const width = video.videoWidth || fallback.width;
    const height = video.videoHeight || fallback.height;
    if (!width || !height) return { blob: null, width, height };
    const scale = Math.min(1, maxWidth / width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return { blob: null, width, height };
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
    return { blob, width, height };
  } catch {
    return { blob: null, ...fallback };
  } finally {
    video.pause();
    video.srcObject = null;
  }
};
