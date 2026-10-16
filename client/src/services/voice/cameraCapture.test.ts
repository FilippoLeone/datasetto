import { describe, expect, it, vi } from 'vitest';
import { CameraError, buildCameraConstraints, cameraAttempts, captureCamera, describeCameraError, isRetriableCameraError } from './cameraCapture';

const domError = (name: string, message = name) => new DOMException(message, name);

const camera = (deviceId: string, label: string) => ({ deviceId, label, kind: 'videoinput', groupId: '', toJSON: () => ({}) }) as MediaDeviceInfo;
const stream = (id: string) => ({ id }) as unknown as MediaStream;

const devicesWith = (getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>, cameras: MediaDeviceInfo[]) => ({
  getUserMedia: vi.fn(getUserMedia),
  enumerateDevices: vi.fn(async () => cameras),
});

const videoOf = (constraints: MediaStreamConstraints) => constraints.video as MediaTrackConstraints;

describe('camera constraints', () => {
  it('asks only for ideals on a desktop', () => {
    const video = videoOf(buildCameraConstraints({}, { mobile: false }));
    expect(video).toEqual({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } });
    expect(JSON.stringify(video)).not.toMatch(/max|min|exact/);
  });

  it('prefers the front camera on phones and skips facing when a camera was chosen', () => {
    expect(videoOf(buildCameraConstraints({}, { mobile: true })).facingMode).toEqual({ ideal: 'user' });
    expect(videoOf(buildCameraConstraints({ facing: 'environment' }, { mobile: true })).facingMode).toEqual({ ideal: 'environment' });
    const chosen = videoOf(buildCameraConstraints({ deviceId: 'cam-2' }, { mobile: true, strictDevice: true }));
    expect(chosen.facingMode).toBeUndefined();
    expect(chosen.deviceId).toEqual({ exact: 'cam-2' });
    expect(videoOf(buildCameraConstraints({ deviceId: 'cam-2' }, { mobile: true })).deviceId).toEqual({ ideal: 'cam-2' });
  });

  it('ends the ladder with a bare request and skips duplicate steps', () => {
    const plain = cameraAttempts({}, false);
    expect(plain.map((attempt) => attempt.step)).toEqual(['preferred', 'bare']);
    expect(plain[1].constraints).toEqual({ video: true, audio: false });
    const chosen = cameraAttempts({ deviceId: 'cam-2' }, false);
    expect(chosen.map((attempt) => attempt.step)).toEqual(['preferred', 'relaxed', 'bare']);
    expect(chosen[2].constraints).toEqual({ video: { deviceId: { ideal: 'cam-2' } }, audio: false });
  });
});

describe('captureCamera', () => {
  it('returns the first stream when the preferred request works', async () => {
    const devices = devicesWith(async () => stream('ok'), [camera('cam-1', 'HD Webcam')]);
    await expect(captureCamera({}, devices)).resolves.toEqual(stream('ok'));
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('retries down to a bare request when the camera refuses the constraints', async () => {
    const devices = devicesWith(async (constraints) => {
      if (constraints.video === true) return stream('bare');
      throw domError('OverconstrainedError', 'Constraints could not be satisfied');
    }, [camera('cam-1', 'HD Webcam')]);
    await expect(captureCamera({}, devices)).resolves.toEqual(stream('bare'));
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(devices.getUserMedia.mock.calls[1][0]).toEqual({ video: true, audio: false });
  });

  it('falls back to another camera when the default one cannot be started', async () => {
    const devices = devicesWith(async (constraints) => {
      const video = constraints.video as MediaTrackConstraints | true;
      if (video !== true && (video.deviceId as ConstrainDOMStringParameters | undefined)?.exact === 'cam-2') return stream('webcam');
      throw domError('NotReadableError', 'Could not start video source');
    }, [camera('cam-1', 'OBS Virtual Camera'), camera('cam-2', 'HD Webcam')]);
    await expect(captureCamera({}, devices)).resolves.toEqual(stream('webcam'));
    expect(devices.enumerateDevices).toHaveBeenCalled();
  });

  it('does not retry a denied permission', async () => {
    const devices = devicesWith(async () => {
      throw domError('NotAllowedError', 'Permission denied');
    }, [camera('cam-1', 'HD Webcam')]);
    const error = await captureCamera({}, devices).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CameraError);
    expect((error as CameraError).kind).toBe('denied');
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('names a virtual camera that is not sending video', async () => {
    const devices = devicesWith(async () => {
      throw domError('NotReadableError', 'Could not start video source');
    }, [camera('cam-1', 'OBS Virtual Camera')]);
    const error = (await captureCamera({}, devices).catch((thrown: unknown) => thrown)) as CameraError;
    expect(error.kind).toBe('busy');
    expect(error.message).toContain('OBS Virtual Camera');
    expect(error.message).toContain('Start Virtual Camera');
    expect(error.message).not.toMatch(/in use by another app/);
  });

  it('reports a missing camera', async () => {
    const devices = devicesWith(async () => {
      throw domError('NotFoundError', 'Requested device not found');
    }, []);
    const error = (await captureCamera({}, devices).catch((thrown: unknown) => thrown)) as CameraError;
    expect(error.kind).toBe('none');
    expect(error.message).toMatch(/No camera was found/);
  });

  it('lists every possibility when the browser hides the camera label', async () => {
    const error = describeCameraError(domError('NotReadableError', 'Failed to allocate videosource'), [{ deviceId: '', label: '' }]);
    expect(error.kind).toBe('busy');
    expect(error.message).toMatch(/in use by another app/);
    expect(error.message).toMatch(/privacy settings/);
    expect(error.message).toMatch(/virtual camera/);
  });

  it('tells a camera that is really in use from one that refused every mode', () => {
    expect(describeCameraError(domError('NotReadableError'), [{ deviceId: 'cam-1', label: 'HD Webcam' }]).message).toMatch(/HD Webcam could not be started/);
    expect(describeCameraError(domError('OverconstrainedError'), [{ deviceId: 'cam-1', label: 'HD Webcam' }]).kind).toBe('constraints');
    expect(isRetriableCameraError(domError('AbortError', 'Starting videoinput failed'))).toBe(true);
    expect(isRetriableCameraError(domError('NotAllowedError'))).toBe(false);
  });

  it('refuses cleanly when getUserMedia is missing', async () => {
    const error = (await captureCamera({}, undefined).catch((thrown: unknown) => thrown)) as CameraError;
    expect(error.kind).toBe('unsupported');
  });
});
