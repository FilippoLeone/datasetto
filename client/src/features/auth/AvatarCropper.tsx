import { useEffect, useRef, useState } from 'preact/hooks';
import { Button, Slider } from '@/components';
import { pinchZoom, pointerDistance } from '@/lib/gestures';
import { MAX_AVATAR_BYTES } from '@/services/avatarUpload';

/** Size of the uploaded image in pixels. */
export const AVATAR_SIZE = 256;
/** On-screen size of the crop window. */
const VIEW_SIZE = 240;
const MAX_ZOOM = 4;

interface AvatarCropperProps {
  file: File;
  onCancel: () => void;
  onDone: (image: Blob) => void;
}

interface Viewport {
  /** 1 = the whole short side fits the window; larger zooms in. */
  zoom: number;
  /** Top-left of the visible region in image pixels. */
  x: number;
  y: number;
}

const loadImage = (file: File): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file is not an image this browser can open'));
    };
    image.src = url;
  });

/** Image pixels covered by the square window at this zoom. */
const regionSize = (image: HTMLImageElement, zoom: number): number => Math.min(image.naturalWidth, image.naturalHeight) / zoom;

const clampViewport = (image: HTMLImageElement, view: Viewport): Viewport => {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom));
  const size = regionSize(image, zoom);
  return {
    zoom,
    x: Math.min(Math.max(0, view.x), image.naturalWidth - size),
    y: Math.min(Math.max(0, view.y), image.naturalHeight - size),
  };
};

const draw = (canvas: HTMLCanvasElement, image: HTMLImageElement, view: Viewport, size: number): void => {
  const context = canvas.getContext('2d');
  if (!context) return;
  const region = regionSize(image, view.zoom);
  context.clearRect(0, 0, size, size);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, view.x, view.y, region, region, 0, 0, size, size);
};

/** Export the window as a 256x256 WebP (PNG where WebP encoding is unavailable), under the upload limit. */
const exportImage = async (image: HTMLImageElement, view: Viewport): Promise<Blob> => {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  draw(canvas, image, view, AVATAR_SIZE);
  const encode = (type: string, quality: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob((blob) => resolve(blob && blob.type === type ? blob : null), type, quality));
  for (const quality of [0.9, 0.8, 0.7]) {
    const webp = await encode('image/webp', quality);
    if (webp && webp.size <= MAX_AVATAR_BYTES) return webp;
    if (!webp) break;
  }
  const png = await encode('image/png', 1);
  if (!png) throw new Error('Could not encode the image');
  if (png.size > MAX_AVATAR_BYTES) throw new Error('The cropped image is too large; try a smaller picture');
  return png;
};

interface Pinch {
  /** Finger distance and zoom when the second finger landed. */
  distance: number;
  zoom: number;
}

/**
 * Pick the square of a picture that becomes the avatar: drag to move, slider,
 * wheel or a two-finger pinch to zoom, live preview in the window itself.
 * Pure canvas, no dependency.
 */
export const AvatarCropper = ({ file, onCancel, onDone }: AvatarCropperProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [view, setView] = useState<Viewport>({ zoom: 1, x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; origin: Viewport } | null>(null);
  /** Fingers on the window, for the pinch. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<Pinch | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loadImage(file)
      .then((loaded) => {
        if (cancelled) return;
        if (loaded.naturalWidth < 32 || loaded.naturalHeight < 32) throw new Error('The picture is too small (32 pixels at least)');
        setImage(loaded);
        // Start centred on the picture.
        const size = regionSize(loaded, 1);
        setView({ zoom: 1, x: (loaded.naturalWidth - size) / 2, y: (loaded.naturalHeight - size) / 2 });
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas && image) draw(canvas, image, view, VIEW_SIZE);
  }, [image, view]);

  const update = (next: Viewport) => {
    if (image) setView(clampViewport(image, next));
  };

  /** Zoom around the centre of the window so the subject stays put. */
  const setZoom = (zoom: number) => {
    if (!image) return;
    const before = regionSize(image, view.zoom);
    const after = regionSize(image, Math.min(MAX_ZOOM, Math.max(1, zoom)));
    update({ zoom, x: view.x + (before - after) / 2, y: view.y + (before - after) / 2 });
  };

  const fingerDistance = (): number => {
    const [a, b] = Array.from(pointers.current.values());
    return a && b ? pointerDistance(a, b) : 0;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!image) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      // Second finger: the drag becomes a pinch around the current view.
      drag.current = null;
      pinch.current = { distance: fingerDistance(), zoom: view.zoom };
      return;
    }
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: view };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!image) return;
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const active = pinch.current;
    if (active && pointers.current.size >= 2) {
      setZoom(pinchZoom(active.zoom, active.distance, fingerDistance(), 1, MAX_ZOOM));
      return;
    }
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // Screen pixels to image pixels at the current zoom.
    const scale = regionSize(image, view.zoom) / VIEW_SIZE;
    update({ ...state.origin, x: state.origin.x - (event.clientX - state.startX) * scale, y: state.origin.y - (event.clientY - state.startY) * scale });
  };
  const onPointerUp = (event: PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
    // The finger that stays after a pinch continues as a drag from where it is.
    if (pointers.current.size === 1 && !drag.current) {
      const [pointerId, point] = Array.from(pointers.current.entries())[0];
      drag.current = { pointerId, startX: point.x, startY: point.y, origin: view };
    }
  };

  const finish = async () => {
    if (!image) return;
    setBusy(true);
    try {
      onDone(await exportImage(image, view));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not prepare the image');
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-3" data-avatar-cropper>
      <div className="relative" style={{ width: VIEW_SIZE, height: VIEW_SIZE }}>
        <canvas
          ref={canvasRef}
          width={VIEW_SIZE}
          height={VIEW_SIZE}
          className="block cursor-grab touch-none rounded-md bg-base active:cursor-grabbing"
          style={{ width: VIEW_SIZE, height: VIEW_SIZE }}
          aria-label="Crop window: drag to move the picture, pinch to zoom"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={(event) => {
            event.preventDefault();
            setZoom(view.zoom * (event.deltaY < 0 ? 1.1 : 0.9));
          }}
        />
        {/* Circle guide: avatars are shown round, so the corners are hidden. */}
        <div className="pointer-events-none absolute inset-0 rounded-md" style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.15)' }} />
        <div className="pointer-events-none absolute inset-0 rounded-full" style={{ boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)', clipPath: 'inset(0 round 6px)' }} />
        {!image && !error && <p className="absolute inset-0 flex items-center justify-center text-sm text-text-muted">Loading…</p>}
      </div>
      {image && (
        <div className="w-full max-w-[240px]">
          <Slider label="Zoom" value={view.zoom} min={1} max={MAX_ZOOM} step={0.01} format={(v) => Math.round(v * 100) + '%'} onChange={setZoom} />
        </div>
      )}
      <p className="text-xs text-text-muted">Drag the picture to move it; pinch, scroll or use the slider to zoom. Saved as {AVATAR_SIZE}×{AVATAR_SIZE}.</p>
      {error && (
        <p role="alert" className="rounded-sm bg-danger/15 px-3 py-2 text-sm text-[#fa777c]">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void finish()} disabled={!image || busy} loading={busy}>
          Use this picture
        </Button>
      </div>
    </div>
  );
};
