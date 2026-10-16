/**
 * Camera capture for voice channels: ideal-only constraints, a retry ladder
 * down to a bare request, a fallback to the machine's other cameras, and error
 * text that tells "really in use or blocked" from "constraints refused" from
 * "no camera at all".
 *
 * Why: a `max` or `exact` constraint is a hard requirement that some webcams
 * and browsers answer with a failure instead of the closest mode, and the
 * browsers report a camera that cannot be started (in use elsewhere, blocked by
 * the OS privacy settings, or a virtual camera whose source is not running) with
 * the same NotReadableError. The old code showed "in use by another app" for all
 * of those.
 */
import { isMobileDevice } from '@/lib/device';

export interface CameraRequest {
  /** A camera the user picked (flipping on a phone); undefined = the browser's default. */
  deviceId?: string;
  /** Preferred facing on phones; desktop webcams have no facing, so it is left out there. */
  facing?: 'user' | 'environment';
}

export type CameraErrorKind = 'denied' | 'none' | 'busy' | 'constraints' | 'unsupported' | 'unknown';

/** What the user sees when the camera cannot be started; `kind` says which case it was. */
export class CameraError extends Error {
  readonly kind: CameraErrorKind;

  constructor(kind: CameraErrorKind, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CameraError';
    this.kind = kind;
  }
}

export interface CameraInfo {
  deviceId: string;
  label: string;
}

type CameraDevices = Pick<MediaDevices, 'getUserMedia'> & Partial<Pick<MediaDevices, 'enumerateDevices'>>;

export const CAMERA_IDEAL = { width: 1280, height: 720, frameRate: 30 } as const;

interface BuildOptions {
  /** `exact` on the chosen camera (first try, so a flip really switches) instead of `ideal`. */
  strictDevice?: boolean;
  /** Overrides the user-agent sniffing (tests). */
  mobile?: boolean;
}

/** Only ideals, never a `max` or a `min`: the browser picks the closest mode instead of failing. */
export const buildCameraConstraints = (request: CameraRequest = {}, options: BuildOptions = {}): MediaStreamConstraints => {
  const mobile = options.mobile ?? isMobileDevice();
  const video: MediaTrackConstraints = {
    width: { ideal: CAMERA_IDEAL.width },
    height: { ideal: CAMERA_IDEAL.height },
    frameRate: { ideal: CAMERA_IDEAL.frameRate },
  };
  if (request.deviceId) {
    video.deviceId = options.strictDevice ? { exact: request.deviceId } : { ideal: request.deviceId };
  } else if (mobile) {
    video.facingMode = { ideal: request.facing ?? 'user' };
  }
  return { video, audio: false };
};

export interface CameraAttempt {
  step: 'preferred' | 'relaxed' | 'bare';
  constraints: MediaStreamConstraints;
}

/** The requests tried in order, from the preferred quality down to a bare `{ video: true }`. */
export const cameraAttempts = (request: CameraRequest = {}, mobile?: boolean): CameraAttempt[] => {
  const ladder: CameraAttempt[] = [
    { step: 'preferred', constraints: buildCameraConstraints(request, { strictDevice: true, mobile }) },
    { step: 'relaxed', constraints: buildCameraConstraints(request, { strictDevice: false, mobile }) },
    { step: 'bare', constraints: { video: request.deviceId ? { deviceId: { ideal: request.deviceId } } : true, audio: false } },
  ];
  const seen = new Set<string>();
  return ladder.filter((attempt) => {
    const key = JSON.stringify(attempt.constraints);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const errorName = (error: unknown): string => {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : '';
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : '');

const isDenied = (error: unknown): boolean => ['NotAllowedError', 'SecurityError', 'PermissionDeniedError'].includes(errorName(error));

const isMissing = (error: unknown): boolean => ['NotFoundError', 'DevicesNotFoundError'].includes(errorName(error));

const isConstraintFailure = (error: unknown): boolean =>
  ['OverconstrainedError', 'ConstraintNotSatisfiedError'].includes(errorName(error)) || /constraint/i.test(errorMessage(error));

/** The camera exists but would not start: in use, blocked, or a virtual camera without a source. */
const isStartFailure = (error: unknown): boolean => ['NotReadableError', 'TrackStartError', 'HardwareError', 'AbortError'].includes(errorName(error));

/** Worth another request with looser constraints or another camera. */
export const isRetriableCameraError = (error: unknown): boolean => isConstraintFailure(error) || isStartFailure(error);

const looksVirtual = (label: string): boolean => /virtual|obs|snap camera|droidcam|iriun|epoccam|ndi|streamlabs|xsplit|manycam/i.test(label);

export const listCameras = async (devices: CameraDevices | undefined = navigator.mediaDevices): Promise<CameraInfo[]> => {
  try {
    const all = (await devices?.enumerateDevices?.()) ?? [];
    return all.filter((device) => device.kind === 'videoinput').map((device) => ({ deviceId: device.deviceId, label: device.label }));
  } catch {
    return [];
  }
};

const describeStartFailure = (cameras: CameraInfo[], requestedId: string | undefined, cause: unknown): CameraError => {
  const requested = requestedId ? cameras.find((camera) => camera.deviceId === requestedId) : undefined;
  const failed = requested ?? (cameras.length === 1 ? cameras[0] : undefined);
  const label = failed?.label.trim() ?? '';
  if (label && looksVirtual(label)) {
    return new CameraError(
      'busy',
      label + ' is not sending video. Start the virtual camera in its app (OBS: Start Virtual Camera) or plug in a webcam, then try again.',
      cause,
    );
  }
  if (label) {
    return new CameraError(
      'busy',
      label + ' could not be started. Close other apps that are using it and check that camera access is allowed in your system privacy settings.',
      cause,
    );
  }
  if (cameras.length > 1) {
    const names = cameras.map((camera) => camera.label.trim()).filter(Boolean);
    return new CameraError(
      'busy',
      'None of your cameras could be started' +
        (names.length > 0 ? ' (' + names.join(', ') + ')' : '') +
        '. Close other apps that are using them, start your virtual camera, or check camera access in your system privacy settings.',
      cause,
    );
  }
  return new CameraError(
    'busy',
    'Your camera could not be started. It is in use by another app, blocked in your system camera privacy settings, or a virtual camera (such as OBS Virtual Camera) that is not running.',
    cause,
  );
};

/**
 * Turn whatever getUserMedia threw into one honest sentence. `cameras` is the
 * list of video inputs (labels are empty until the browser has granted access
 * once, so the text degrades gracefully).
 */
export const describeCameraError = (error: unknown, cameras: CameraInfo[] = [], requestedId?: string): CameraError => {
  if (error instanceof CameraError) return error;
  if (isDenied(error)) {
    return new CameraError('denied', 'Camera permission was denied. Allow camera access for Datasetto in your browser or system settings, then try again.', error);
  }
  if (isMissing(error) || (cameras.length === 0 && !isStartFailure(error) && !isConstraintFailure(error))) {
    return new CameraError('none', 'No camera was found. Connect a webcam, or start your virtual camera, then try again.', error);
  }
  if (isStartFailure(error)) return describeStartFailure(cameras, requestedId, error);
  if (isConstraintFailure(error)) {
    return new CameraError('constraints', 'The selected camera is no longer available or refused every requested mode. Reconnect it and try again.', error);
  }
  if (errorName(error) === 'TypeError' || /not supported|not a function/i.test(errorMessage(error))) {
    return new CameraError('unsupported', 'Camera access is not supported in this browser.', error);
  }
  const name = errorName(error);
  return new CameraError('unknown', 'Could not start the camera' + (name ? ' (' + name + ')' : '') + '.', error);
};

/**
 * Open a camera. Tries the preferred mode, then looser constraints, then a bare
 * request; when the chosen or default camera refuses to start and the machine
 * has other cameras, those are tried too (a virtual camera is often listed
 * first). Throws a CameraError with user-facing text.
 */
export const captureCamera = async (request: CameraRequest = {}, devices: CameraDevices | undefined = navigator.mediaDevices): Promise<MediaStream> => {
  if (!devices || typeof devices.getUserMedia !== 'function') {
    throw new CameraError('unsupported', 'Camera access is not supported in this browser.');
  }
  let lastError: unknown;
  for (const attempt of cameraAttempts(request)) {
    try {
      return await devices.getUserMedia(attempt.constraints);
    } catch (error) {
      lastError = error;
      if (!isRetriableCameraError(error)) break;
      if (import.meta.env.DEV) console.warn('[camera] ' + attempt.step + ' request failed, retrying', error);
    }
  }
  const cameras = await listCameras(devices);
  if (isStartFailure(lastError) && cameras.length > 1) {
    for (const camera of cameras) {
      if (!camera.deviceId || camera.deviceId === request.deviceId) continue;
      try {
        return await devices.getUserMedia({ video: { deviceId: { exact: camera.deviceId } }, audio: false });
      } catch (error) {
        if (isDenied(error)) throw describeCameraError(error, cameras, request.deviceId);
        if (import.meta.env.DEV) console.warn('[camera] ' + (camera.label || camera.deviceId) + ' failed too', error);
      }
    }
  }
  throw describeCameraError(lastError, cameras, request.deviceId);
};
