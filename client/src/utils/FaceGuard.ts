import type { NotificationManager } from '@/components/NotificationManager';

export interface FaceGuardOptions {
  overlay: HTMLElement | null;
  toggleButton: HTMLButtonElement | null;
  dismissButton: HTMLButtonElement | null;
  notifications: NotificationManager;
}

const PORTRAIT_PITCH_THRESHOLD = 55;
const PORTRAIT_ROLL_THRESHOLD = 25;

export class FaceGuard {
  private overlay: HTMLElement | null;
  private toggleButton: HTMLButtonElement | null;
  private dismissButton: HTMLButtonElement | null;
  private notifications: NotificationManager;
  private permissionGranted = false;
  private enabled = false;
  private voiceActive = false;
  private engaged = false;
  private orientationAttached = false;

  private readonly handleToggleBound: () => void;
  private readonly handleDismissBound: () => void;
  private readonly handleOverlayClickBound: (event: MouseEvent) => void;
  private readonly handleOrientationBound: (event: DeviceOrientationEvent) => void;

  constructor(options: FaceGuardOptions) {
    this.overlay = options.overlay;
    this.toggleButton = options.toggleButton;
    this.dismissButton = options.dismissButton;
    this.notifications = options.notifications;

    this.handleToggleBound = () => {
      void this.toggle();
    };
    this.handleDismissBound = (event?: Event) => {
      event?.stopPropagation();
      this.disable(true);
    };
    this.handleOverlayClickBound = (event: MouseEvent) => {
      if (event.target === this.overlay) {
        this.disable(true);
      }
    };
    this.handleOrientationBound = (event: DeviceOrientationEvent) => {
      this.handleOrientation(event);
    };

    this.toggleButton?.addEventListener('click', this.handleToggleBound);
    this.dismissButton?.addEventListener('click', this.handleDismissBound);
    this.overlay?.addEventListener('click', this.handleOverlayClickBound);

    this.updateToggleState();
  }

  dispose(): void {
    this.detachOrientation();
    this.toggleButton?.removeEventListener('click', this.handleToggleBound);
    this.dismissButton?.removeEventListener('click', this.handleDismissBound);
    this.overlay?.removeEventListener('click', this.handleOverlayClickBound);
    this.hideOverlay();
  }

  setVoiceActive(active: boolean): void {
    this.voiceActive = active;

    if (active && this.enabled) {
      this.attachOrientation();
    } else {
      this.detachOrientation();
      this.release();
    }

    if (!active) {
      this.hideOverlay();
    }
  }

  private async toggle(): Promise<void> {
    if (this.enabled) {
      this.disable(true);
      return;
    }

    await this.enable();
  }

  async enable(): Promise<void> {
    if (this.enabled) {
      return;
    }

    const permissionGranted = await this.ensurePermission();
    if (!permissionGranted) {
      return;
    }

    if (!this.supportsOrientation()) {
      this.notifications.error('Face guard requires motion sensors that are not supported on this device.');
      return;
    }

    this.enabled = true;
    this.updateToggleState();

    if (this.voiceActive) {
      this.attachOrientation();
    }

    this.notifications.success('Face guard enabled. Move the device away from your face to unlock.');
  }

  disable(manual = false): void {
    if (!this.enabled && !this.engaged) {
      return;
    }

    this.enabled = false;
    this.updateToggleState();
    this.release();
    this.detachOrientation();

    if (manual) {
      this.notifications.info('Face guard disabled.');
    }
  }

  private supportsOrientation(): boolean {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  private async ensurePermission(): Promise<boolean> {
    if (this.permissionGranted) {
      return true;
    }

    if (typeof DeviceOrientationEvent === 'undefined') {
      return false;
    }

    const requestPermission = (DeviceOrientationEvent as typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
    }).requestPermission;

    if (typeof requestPermission === 'function') {
      try {
        const result = await requestPermission.call(DeviceOrientationEvent);
        this.permissionGranted = result === 'granted';
        if (!this.permissionGranted) {
          this.notifications.error('Motion access was denied. Enable it in Settings to use face guard.');
        }
        return this.permissionGranted;
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[FaceGuard] Motion permission request failed:', error);
        }
        this.notifications.error('Unable to request motion access.');
        return false;
      }
    }

    // Browsers without requestPermission implicitly grant access when available
    this.permissionGranted = true;
    return true;
  }

  private attachOrientation(): void {
    if (this.orientationAttached) {
      return;
    }
    window.addEventListener('deviceorientation', this.handleOrientationBound, true);
    this.orientationAttached = true;
  }

  private detachOrientation(): void {
    if (!this.orientationAttached) {
      return;
    }
    window.removeEventListener('deviceorientation', this.handleOrientationBound, true);
    this.orientationAttached = false;
  }

  private handleOrientation(event: DeviceOrientationEvent): void {
    if (!this.enabled || !this.voiceActive) {
      return;
    }

    const pitch = event.beta ?? 0;
    const roll = event.gamma ?? 0;

    const isPortraitLike = Math.abs(pitch) > PORTRAIT_PITCH_THRESHOLD && Math.abs(roll) < PORTRAIT_ROLL_THRESHOLD;

    if (isPortraitLike) {
      this.engage();
    } else {
      this.release();
    }
  }

  private engage(): void {
    if (this.engaged) {
      return;
    }

    this.engaged = true;
    this.showOverlay();
  }

  private release(): void {
    if (!this.engaged) {
      return;
    }

    this.engaged = false;
    this.hideOverlay();
  }

  private showOverlay(): void {
    this.overlay?.classList.remove('hidden');
    document.body.classList.add('face-guard-lock');
  }

  private hideOverlay(): void {
    this.overlay?.classList.add('hidden');
    document.body.classList.remove('face-guard-lock');
  }

  private updateToggleState(): void {
    if (!this.toggleButton) {
      return;
    }

    this.toggleButton.setAttribute('aria-pressed', this.enabled ? 'true' : 'false');
    this.toggleButton.classList.toggle('active', this.enabled);
    this.toggleButton.setAttribute('aria-label', this.enabled ? 'Disable face guard' : 'Enable face guard');
  }
}
