import '@/styles/app.css';
import { render } from 'preact';
import { App } from '@/app/App';
import { runtimeUrls } from '@/lib/runtimeConfig';
import { serverConfig } from '@/services/ServerConfigService';
import { installSocketBindings } from '@/services/socket/bindings';
import { socketClient } from '@/services/socket/client';
import { voiceManager } from '@/features/voice/voiceManager';
import { screenshareService } from '@/features/screenshare/screenshareService';
import { installCapacitorAppHandlers } from '@/services/native/capacitorApp';
import { installUpdateNotices } from '@/services/updates';
import { captureInviteFromUrl } from '@/state/session';

const bootstrap = async (): Promise<void> => {
  captureInviteFromUrl();
  // Runtime config (registration mode, ICE servers, public URLs). Non-fatal when unreachable.
  await serverConfig.load(runtimeUrls.apiBaseUrl);
  installSocketBindings();
  voiceManager.init();
  screenshareService.init();
  void installCapacitorAppHandlers();
  installUpdateNotices();
  socketClient.connect(runtimeUrls.serverUrl);
  render(<App />, document.getElementById('app') as HTMLElement);
};

void bootstrap();
