/**
 * SettingsController
 * Manages audio settings modal, device selection, and audio configuration
 */

import type { StateManager, AnimationController } from '@/utils';
import type { AudioService, AudioNotificationService } from '@/services';
import type { NotificationManager } from '@/components/NotificationManager';
import { fetchNativeAudioRoutes } from '@/services';

export interface SettingsControllerDeps {
  elements: Record<string, HTMLElement | null>;
  state: StateManager;
  audio: AudioService;
  animator: AnimationController;
  soundFX: AudioNotificationService;
  notifications: NotificationManager;
  registerCleanup: (cleanup: () => void) => void;
  voiceSetOutputVolume: (volume: number) => void;
  voiceSetOutputDevice: (deviceId: string | null) => Promise<void> | void;
}

export class SettingsController {
  private deps: SettingsControllerDeps;
  private captureNextKey = false;

  constructor(deps: SettingsControllerDeps) {
    this.deps = deps;
  }

  initialize(): void {
    this.setupSettingsListeners();
  }

  dispose(): void {
    // Cleanup handled by registerCleanup
  }

  /**
   * Load audio devices into select elements (called during app initialization)
   */
  async loadDevices(): Promise<void> {
    try {
      const { mics, speakers } = await this.deps.audio.getDevices();
      
      if (this.deps.elements.micSelect) {
        const micSelect = this.deps.elements.micSelect as HTMLSelectElement;
        micSelect.innerHTML = mics.map(d => 
          `<option value="${d.deviceId}">${d.label}</option>`
        ).join('');
      }

      if (this.deps.elements.spkSelect) {
        const spkSelect = this.deps.elements.spkSelect as HTMLSelectElement;
        spkSelect.innerHTML = speakers.map(d => 
          `<option value="${d.deviceId}">${d.label}</option>`
        ).join('');
      }
    } catch (error) {
      console.error('Error loading devices:', error);
    }
  }

  /**
   * Show audio settings modal
   */
  async showAudioSettingsModal(): Promise<void> {
    if (import.meta.env.DEV) {
      console.log('🔊 SettingsController.showAudioSettingsModal called');
    }

    const modal = this.deps.elements.audioSettingsModal;
    if (!modal) {
      if (import.meta.env.DEV) {
        console.error('❌ Audio settings modal element not found!');
      }
      return;
    }

    // Show modal immediately so UI isn't blocked by device enumeration
    this.deps.animator.openModal(modal);
    this.deps.soundFX.play('click', 0.4);

    // Reflect the last known settings right away
    this.updateSettingsUI();

    // Populate device lists asynchronously; refresh settings when ready
    void this.populateDeviceLists().then(() => {
      this.updateSettingsUI();
    });
  }

  /**
   * Hide audio settings modal
   */
  hideAudioSettingsModal(): void {
    const modal = this.deps.elements.audioSettingsModal;
    if (!modal) return;
    
    // Stop mic test if running
    const testBtn = this.deps.elements.testMicBtn as HTMLButtonElement;
    if (testBtn && testBtn.getAttribute('data-testing') === 'true') {
      if (!this.deps.state.get('voiceConnected')) {
        this.deps.audio.stopLocalStream();
      } else {
        const { muted } = this.deps.state.getState();
        this.deps.audio.setMuted(muted);
      }
      testBtn.textContent = 'Test Microphone';
      testBtn.setAttribute('data-testing', 'false');
      testBtn.classList.remove('button-danger');
      testBtn.classList.add('button-secondary');
      if (import.meta.env.DEV) {
        console.log('🛑 Stopped mic test when closing settings');
      }
    }
    
    this.deps.animator.closeModal(modal);
  }

  /**
   * Save audio settings
   */
  saveAudioSettings(): void {
    if (import.meta.env.DEV) {
      console.log('💾 Saving audio settings...');
    }

    // Settings are saved in real-time via setupSettingsListeners
    // This just closes the modal
    this.deps.notifications.success('Audio settings saved');
    this.hideAudioSettingsModal();
    this.deps.soundFX.play('success', 0.6);
  }

  /**
   * Handle microphone device change
   */
  async handleMicChange(): Promise<void> {
    const select = this.deps.elements.micSelect as HTMLSelectElement;
    const deviceId = select?.value;
    if (!deviceId) {
      return;
    }

    const previousMic = this.deps.state.get('settings').micDeviceId;
    if (previousMic === deviceId) {
      return;
    }

    this.deps.state.updateSettings({ micDeviceId: deviceId });

    try {
      await this.deps.audio.updateSettings({ micDeviceId: deviceId });
      this.deps.notifications.success('Microphone changed');
    } catch (error) {
      console.error('Error switching microphone:', error);
      this.deps.notifications.error('Failed to switch microphone');
      return;
    }

    const testBtn = this.deps.elements.testMicBtn as HTMLButtonElement | null;
    const isTesting = testBtn?.getAttribute('data-testing') === 'true';
    const voiceConnected = this.deps.state.get('voiceConnected');

    if (isTesting) {
      try {
        if (voiceConnected) {
          await this.deps.audio.getLocalStream(false);
        } else {
          await this.deps.audio.getLocalStream(true);
        }
        this.deps.notifications.info('Test restarted with new device');
      } catch (error) {
        console.error('Error restarting microphone test:', error);
        this.deps.notifications.error('Could not restart microphone test');
      }
    }
  }

  /**
   * Handle microphone test toggle
   */
  async handleTestMicToggle(): Promise<void> {
    const btn = this.deps.elements.testMicBtn as HTMLButtonElement;
    if (!btn) return;

    const isTesting = btn.getAttribute('data-testing') === 'true';
    const voiceConnected = this.deps.state.get('voiceConnected');

    if (isTesting) {
      // Stop testing
      if (!voiceConnected) {
        this.deps.audio.stopLocalStream();
      } else {
        const { muted } = this.deps.state.getState();
        this.deps.audio.setMuted(muted);
      }
      btn.textContent = 'Test Microphone';
      btn.setAttribute('data-testing', 'false');
      btn.classList.remove('button-danger');
      btn.classList.add('button-secondary');
      this.deps.soundFX.play('click', 0.4);
      this.deps.notifications.info('Microphone test stopped');
    } else {
      // Start testing
      try {
        await this.deps.audio.getLocalStream(false);
        btn.textContent = 'Stop Test';
        btn.setAttribute('data-testing', 'true');
        btn.classList.remove('button-secondary');
        btn.classList.add('button-danger');
        this.deps.soundFX.play('success', 0.5);
        this.deps.notifications.info('Microphone test started - speak to see level');
      } catch (error) {
        console.error('Error starting mic:', error);
        this.deps.soundFX.play('error', 0.5);
        this.deps.notifications.error('Failed to start microphone. Please check permissions.');
      }
    }
  }

  /**
   * Handle PTT key binding setup
   */
  handlePttSetKey(): void {
    this.captureNextKey = true;
    const input = this.deps.elements.pttKey as HTMLInputElement;
    if (input) input.value = 'Press a key…';
  }

  /**
   * Capture key for PTT binding
   */
  capturePttKey(e: KeyboardEvent): boolean {
    if (this.captureNextKey) {
      e.preventDefault();
      const pttKey = e.code;
      this.deps.state.updateSettings({ pttKey });
      const input = this.deps.elements.pttKey as HTMLInputElement;
      if (input) input.value = pttKey;
      this.captureNextKey = false;
      return true;
    }
    return false;
  }

  /**
   * Update settings UI from state
   */
  updateSettingsUI(): void {
    const settings = this.deps.state.get('settings');
    
    const checkboxIds = ['echoCancel', 'noiseSuppression', 'autoGain', 'pttEnable'];
    checkboxIds.forEach(id => {
      const el = this.deps.elements[id] as HTMLInputElement;
      if (el) el.checked = settings[id as keyof typeof settings] as boolean;
    });

    const rangeIds = ['micGain', 'outputVol'];
    rangeIds.forEach(id => {
      const el = this.deps.elements[id] as HTMLInputElement;
      if (el) el.value = String(settings[id as keyof typeof settings]);
    });

    const pttKeyInput = this.deps.elements.pttKey as HTMLInputElement;
    if (pttKeyInput) pttKeyInput.value = settings.pttKey;

    if (this.deps.elements.micGainVal) {
      this.deps.elements.micGainVal.textContent = `${settings.micGain.toFixed(1)}x`;
    }
    if (this.deps.elements.outputVolVal) {
      this.deps.elements.outputVolVal.textContent = `${Math.round(settings.outputVol * 100)}%`;
    }
  }

  /**
   * Populate device dropdown lists
   */
  private async populateDeviceLists(): Promise<void> {
    const micSelect = this.deps.elements.micSelect as HTMLSelectElement;
    const spkSelect = this.deps.elements.spkSelect as HTMLSelectElement;

    if (micSelect) {
      micSelect.innerHTML = '<option value="">System Default Microphone</option>';
      micSelect.disabled = true;
      micSelect.title = 'Using system default until devices are detected…';
    }

    if (spkSelect) {
      spkSelect.innerHTML = '<option>System Default</option>';
      spkSelect.disabled = true;
      spkSelect.title = 'Loading available speakers…';
    }

    try {
      // Request permissions first to get device labels
      let permissionStream: MediaStream | null = null;
      try {
        permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (permissionError) {
        if (import.meta.env.DEV) {
          console.warn('⚠️ Unable to prefetch media device labels:', permissionError);
        }
      } finally {
        if (permissionStream) {
          permissionStream.getTracks().forEach((track) => track.stop());
        }
      }

      const devices = await this.deps.audio.getDevices();

      if (micSelect) {
        micSelect.innerHTML = '';

        const defaultMicOption = document.createElement('option');
        defaultMicOption.value = '';
        defaultMicOption.textContent = 'System Default Microphone';
        micSelect.appendChild(defaultMicOption);

        const micMap = new Map<string, string>();

        if (devices.mics.length > 0) {
          devices.mics.forEach((device) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `Microphone ${device.deviceId.substring(0, 8)}`;
            micSelect.appendChild(option);
            micMap.set(device.deviceId, option.textContent);
          });

          micSelect.disabled = false;
          micSelect.removeAttribute('title');
        } else {
          micSelect.disabled = true;
          micSelect.title = 'No dedicated microphones detected. Falling back to system default.';
        }

        const currentMic = this.deps.state.get('settings').micDeviceId;
        if (currentMic && micMap.has(currentMic)) {
          micSelect.value = currentMic;
        } else {
          micSelect.value = '';
        }
      }

      // Populate speaker dropdown
      const nativeRoutes = await fetchNativeAudioRoutes();
  const supportsOutputSelection = this.deps.audio.supportsOutputDeviceSelection() || nativeRoutes.length > 0;

      if (spkSelect) {
        const speakerMap = new Map<string, { deviceId: string; label: string }>();

        // Add Web Audio API speakers
        devices.speakers.forEach((device) => {
          speakerMap.set(device.deviceId, {
            deviceId: device.deviceId,
            label: device.label || `Speaker ${device.deviceId.substring(0, 8)}`,
          });
        });

        // Add native routes (if available) - these take precedence
        nativeRoutes.forEach((route) => {
          const nativeId = `native:${route.id}`;
          speakerMap.set(nativeId, {
            deviceId: nativeId,
            label: `${route.label} (Native)`,
          });
        });

        const speakerEntries = Array.from(speakerMap.values());

        spkSelect.innerHTML = '';

        if (!supportsOutputSelection && speakerEntries.length === 0) {
          spkSelect.innerHTML = '<option>No speakers found</option>';
          spkSelect.disabled = true;
          spkSelect.title = 'Switching audio output is not supported by this browser. Use system controls instead.';
        } else {
          const defaultOption = document.createElement('option');
          defaultOption.value = '';
          defaultOption.textContent = nativeRoutes.length > 0 ? 'Speakerphone (default)' : supportsOutputSelection ? 'System Default' : 'System Route';
          spkSelect.appendChild(defaultOption);

          speakerEntries.forEach((device) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label;
            spkSelect.appendChild(option);
          });

          const currentSettings = this.deps.state.get('settings');
          let selectedValue = currentSettings.spkDeviceId ?? '';

          if (!selectedValue && nativeRoutes.length > 0) {
            const activeRoute = nativeRoutes.find((route) => route.selected);
            if (activeRoute) {
              const nativeId = `native:${activeRoute.id}`;
              if (speakerMap.has(nativeId)) {
                selectedValue = nativeId;
              }
            }
          }

          if (selectedValue && !speakerMap.has(selectedValue)) {
            selectedValue = '';
          }

          spkSelect.value = selectedValue;
          spkSelect.disabled = !supportsOutputSelection && speakerEntries.length === 0;

          if (!supportsOutputSelection) {
            spkSelect.title = 'Switching audio output is not supported by this browser. Use system controls instead.';
          } else if (speakerEntries.length === 0) {
            spkSelect.title = 'No alternate speakers detected. Connect a device to switch outputs.';
          } else {
            spkSelect.removeAttribute('title');
          }
        }
      }

      if (import.meta.env.DEV) {
        console.log('📱 Populated devices:', devices.mics.length, 'mics,', devices.speakers.length, 'speakers');
      }
    } catch (error) {
      console.error('❌ Error populating devices:', error);
      this.deps.notifications.error('Could not load audio devices. Please check permissions.');
      
      // Set fallback options
      const micSelect = this.deps.elements.micSelect as HTMLSelectElement;
      const spkSelect = this.deps.elements.spkSelect as HTMLSelectElement;
      if (micSelect) {
        micSelect.innerHTML = '<option value="">System Default Microphone</option>';
        micSelect.disabled = true;
        micSelect.title = 'Unable to enumerate microphones. Using system default.';
      }
      if (spkSelect) {
        spkSelect.innerHTML = '<option>System Default</option>';
        spkSelect.disabled = true;
        spkSelect.title = 'Unable to enumerate speakers. Using system default.';
      }
    }
  }

  /**
   * Setup all settings event listeners
   */
  private setupSettingsListeners(): void {
    // Checkbox settings (voice processing, PTT)
    const checkboxIds = ['echoCancel', 'noiseSuppression', 'autoGain', 'pttEnable'];
    for (const id of checkboxIds) {
      this.deps.elements[id]?.addEventListener('change', async () => {
        await this.handleSettingChange(id);
      });
    }

    // Range slider settings (gain, volume)
    const micGainInput = this.deps.elements.micGain as HTMLInputElement;
    const outputVolInput = this.deps.elements.outputVol as HTMLInputElement;

    if (micGainInput) {
      micGainInput.addEventListener('input', () => {
        const val = parseFloat(micGainInput.value);
        if (this.deps.elements.micGainVal) {
          this.deps.elements.micGainVal.textContent = `${val.toFixed(1)}x`;
        }
      });
      micGainInput.addEventListener('change', async () => {
        await this.handleSettingChange('micGain');
      });
    }

    if (outputVolInput) {
      outputVolInput.addEventListener('input', () => {
        const val = parseFloat(outputVolInput.value);
        if (this.deps.elements.outputVolVal) {
          this.deps.elements.outputVolVal.textContent = `${Math.round(val * 100)}%`;
        }
      });
      outputVolInput.addEventListener('change', async () => {
        await this.handleSettingChange('outputVol');
      });
    }

    // Device selection dropdowns
    const micSelect = this.deps.elements.micSelect as HTMLSelectElement;
    const spkSelect = this.deps.elements.spkSelect as HTMLSelectElement;

    if (micSelect) {
      micSelect.addEventListener('change', () => {
        void this.handleMicChange();
      });
    }

    if (spkSelect) {
      spkSelect.addEventListener('change', async () => {
        const deviceId = spkSelect.value || null;
        this.deps.state.updateSettings({ spkDeviceId: deviceId ?? undefined });

        try {
          await this.deps.voiceSetOutputDevice(deviceId);
          this.deps.notifications.success('Speaker route updated');
        } catch (error) {
          console.error('Error selecting speaker device:', error);
          const message = error instanceof Error ? error.message : 'Failed to switch speaker output.';
          this.deps.notifications.error(message);
        }
      });
    }

    // PTT Key binding
    const pttSetKeyBtn = this.deps.elements.pttSetKey as HTMLButtonElement;
    const pttKeyInput = this.deps.elements.pttKey as HTMLInputElement;

    if (pttSetKeyBtn && pttKeyInput) {
      pttSetKeyBtn.addEventListener('click', () => {
        pttKeyInput.value = 'Press any key...';
        pttKeyInput.classList.add('recording');
        
        const keyHandler = (e: KeyboardEvent) => {
          e.preventDefault();
          pttKeyInput.value = e.code;
          pttKeyInput.classList.remove('recording');
          this.deps.state.updateSettings({ pttKey: e.code });
          this.deps.notifications.success(`PTT key set to ${e.code}`);
          document.removeEventListener('keydown', keyHandler);
        };
        
        document.addEventListener('keydown', keyHandler, { once: true });
      });
    }
  }

  /**
   * Handle individual setting change
   */
  private async handleSettingChange(id: string): Promise<void> {
    const element = this.deps.elements[id];
    if (!element) return;

    const updates: Record<string, boolean | number | string> = {};

    if (element instanceof HTMLInputElement) {
      if (element.type === 'checkbox') {
        updates[id] = element.checked;
      } else if (element.type === 'range') {
        updates[id] = parseFloat(element.value);
      }
    }

    this.deps.state.updateSettings(updates);

    // Apply changes
    if (id === 'micGain') {
      this.deps.audio.setMicGain(updates[id] as number);
      if (this.deps.elements.micGainVal) {
        this.deps.elements.micGainVal.textContent = `${(updates[id] as number).toFixed(1)}x`;
      }
    } else if (id === 'outputVol') {
      this.deps.voiceSetOutputVolume(updates[id] as number);
      if (this.deps.elements.outputVolVal) {
        this.deps.elements.outputVolVal.textContent = `${Math.round((updates[id] as number) * 100)}%`;
      }
    } else if (['echoCancel', 'noiseSuppression', 'autoGain'].includes(id)) {
      await this.deps.audio.updateSettings(updates);
    }
  }
}
