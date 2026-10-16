import '@/styles/app.css';
import { render } from 'preact';
import { App } from '@/app/App';
import { installBackStack } from '@/lib/backStack';
import { isCapacitor, isTouchPrimary } from '@/lib/device';
import { installKeyboardTracking } from '@/lib/keyboard';
import { runtimeUrls } from '@/lib/runtimeConfig';
import { serverConfig } from '@/services/ServerConfigService';
import { installSocketBindings } from '@/services/socket/bindings';
import { socketClient } from '@/services/socket/client';
import { voiceManager } from '@/features/voice/voiceManager';
import { installDesktopVoice } from '@/features/voice/desktopVoice';
import { screenshareService } from '@/features/screenshare/screenshareService';
import { installCapacitorAppHandlers } from '@/services/native/capacitorApp';
import { installInstallPrompt } from '@/services/installPrompt';
import { installPushListeners, refreshPushStatus } from '@/services/pushNotifications';
import { captureChannelFromUrl } from '@/state/channels';
import { captureInviteFromUrl } from '@/state/session';

const bootstrap = async (): Promise<void> => {
  captureInviteFromUrl();
  captureChannelFromUrl();
  // Back closes panels before leaving: Capacitor has its own back event, touch browsers get a history entry per panel.
  installBackStack({ history: !isCapacitor() && isTouchPrimary() });
  installKeyboardTracking();
  // Chrome fires beforeinstallprompt early: listen before anything awaits.
  installInstallPrompt();
  // Runtime config (registration mode, ICE servers, public URLs, push). Non-fatal when unreachable.
  await serverConfig.load(runtimeUrls.apiBaseUrl);
  installSocketBindings();
  installPushListeners();
  void refreshPushStatus();
  voiceManager.init();
  installDesktopVoice();
  screenshareService.init();
  void installCapacitorAppHandlers();
  socketClient.connect(runtimeUrls.serverUrl);
  render(<App />, document.getElementById('app') as HTMLElement);
};

void bootstrap();
