import '@/styles/app.css';
import { render } from 'preact';
import { App } from '@/app/App';
import { runtimeUrls } from '@/lib/runtimeConfig';
import { serverConfig } from '@/services/ServerConfigService';
import { installSocketBindings } from '@/services/socket/bindings';
import { socketClient } from '@/services/socket/client';
import { voiceManager } from '@/features/voice/voiceManager';
import { screenshareService } from '@/features/screenshare/screenshareService';

const bootstrap = async (): Promise<void> => {
  // Runtime config (registration mode, ICE servers, public URLs). Non-fatal when unreachable.
  await serverConfig.load(runtimeUrls.apiBaseUrl);
  installSocketBindings();
  voiceManager.init();
  screenshareService.init();
  socketClient.connect(runtimeUrls.serverUrl);
  render(<App />, document.getElementById('app') as HTMLElement);
};

void bootstrap();
