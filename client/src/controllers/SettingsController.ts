/**
 * SettingsController
 * Manages audio settings modal, device selection, and audio configuration
 */

import type { StateManager, AnimationController } from '@/utils';
import type { AudioService } from '@/services';
import type { NotificationManager } from '@/components/NotificationManager';
import type { AudioNotificationService } from '@/services';

export interface SettingsControllerDeps {
  elements: Record<string, HTMLElement | null>;
  state: StateManager;
  audio: AudioService;
  animator: AnimationController;
  soundFX: AudioNotificationService;
  notifications: NotificationManager;
  registerCleanup: (cleanup: () => void) => void;
  voiceSetOutputVolume: (volume: number) => void;
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

    // Populate device lists
    await this.populateDeviceLists();

    // Update UI with current settings
    this.updateSettingsUI();

    // Show modal with animation
    modal.style.display = 'flex';
    this.deps.animator.openModal(modal);
    this.deps.soundFX.play('click', 0.4);
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
      this.deps.audio.stopLocalStream();
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
    
    if (deviceId) {
      this.deps.state.updateSettings({ micDeviceId: deviceId });
      await this.deps.audio.updateSettings({ micDeviceId: deviceId });
    }
  }

  /**
   * Handle microphone test toggle
   */
  async handleTestMicToggle(): Promise<void> {
    const btn = this.deps.elements.testMicBtn as HTMLButtonElement;
    if (!btn) return;

    const isTesting = btn.getAttribute('data-testing') === 'true';

    if (isTesting) {
      // Stop testing
      this.deps.audio.stopLocalStream();
      btn.textContent = 'Test Microphone';
      btn.setAttribute('data-testing', 'false');
      btn.classList.remove('button-danger');
      btn.classList.add('button-secondary');
      this.deps.soundFX.play('click', 0.4);
      this.deps.notifications.info('Microphone test stopped');
    } else {
      // Start testing
      try {
        await this.deps.audio.getLocalStream();
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
    try {
      // Request permissions first to get device labels
      await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      
      const devices = await this.deps.audio.getDevices();
      
      // Populate microphone dropdown
      const micSelect = this.deps.elements.micSelect as HTMLSelectElement;
      if (micSelect && devices.mics.length > 0) {
        micSelect.innerHTML = '';
        devices.mics.forEach(device => {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || `Microphone ${device.deviceId.substring(0, 8)}`;
          micSelect.appendChild(option);
        });
        
        // Select current device
        const currentMic = this.deps.state.get('settings').micDeviceId;
        if (currentMic) {
          micSelect.value = currentMic;
        }
      }

      // Populate speaker dropdown
      const spkSelect = this.deps.elements.spkSelect as HTMLSelectElement;
      if (spkSelect && devices.speakers.length > 0) {
        spkSelect.innerHTML = '';
        devices.speakers.forEach(device => {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || `Speaker ${device.deviceId.substring(0, 8)}`;
          spkSelect.appendChild(option);
        });
        
        // Select current device
        const currentSpk = this.deps.state.get('settings').spkDeviceId;
        if (currentSpk) {
          spkSelect.value = currentSpk;
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
      if (micSelect) micSelect.innerHTML = '<option>No microphones found</option>';
      if (spkSelect) spkSelect.innerHTML = '<option>No speakers found</option>';
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
      micSelect.addEventListener('change', async () => {
        const deviceId = micSelect.value;
        this.deps.state.updateSettings({ micDeviceId: deviceId });
        this.deps.notifications.success('Microphone changed');
        
        // If currently testing, restart with new device
        const testBtn = this.deps.elements.testMicBtn as HTMLButtonElement;
        if (testBtn && testBtn.getAttribute('data-testing') === 'true') {
          this.deps.audio.stopLocalStream();
          try {
            await this.deps.audio.getLocalStream(true); // Force new stream
            this.deps.notifications.info('Test restarted with new device');
          } catch (error) {
            console.error('Error switching microphone:', error);
            this.deps.notifications.error('Failed to switch microphone');
          }
        }
      });
    }

    if (spkSelect) {
      spkSelect.addEventListener('change', () => {
        const deviceId = spkSelect.value;
        this.deps.state.updateSettings({ spkDeviceId: deviceId });
        this.deps.notifications.success('Speaker changed');
        // TODO: Apply speaker device to audio output
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
