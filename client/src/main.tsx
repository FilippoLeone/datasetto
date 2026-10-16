import '@/styles/app.css';
import { render } from 'preact';
import { App } from '@/app/App';
import { runtimeUrls } from '@/lib/runtimeConfig';
import { serverConfig } from '@/services/ServerConfigService';
import { installSocketBindings } from '@/services/socket/bindings';
import { socketClient } from '@/services/socket/client';
import { voiceManager } from '@/features/voice/voiceManager';
import { installDesktopVoice } from '@/features/voice/desktopVoice';
import { installDesktopActivity } from '@/features/activity/desktopActivity';
import { screenshareService } from '@/features/screenshare/screenshareService';
import { installCapacitorAppHandlers } from '@/services/native/capacitorApp';
import { installPushListeners, refreshPushStatus } from '@/services/pushNotifications';
import { captureChannelFromUrl } from '@/state/channels';
import { captureInviteFromUrl } from '@/state/session';

const bootstrap = async (): Promise<void> => {
  captureInviteFromUrl();
  captureChannelFromUrl();
  // Runtime config (registration mode, ICE servers, public URLs, push). Non-fatal when unreachable.
  await serverConfig.load(runtimeUrls.apiBaseUrl);
  installSocketBindings();
  installPushListeners();
  void refreshPushStatus();
  voiceManager.init();
  installDesktopVoice();
  installDesktopActivity();
  screenshareService.init();
  void installCapacitorAppHandlers();
  socketClient.connect(runtimeUrls.serverUrl);
  render(<App />, document.getElementById('app') as HTMLElement);
};

void bootstrap();
