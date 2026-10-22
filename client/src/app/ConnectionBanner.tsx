import { useEffect, useState } from 'preact/hooks';
import { Gamepad2, RefreshCw, WifiOff } from 'lucide-preact';
import { cn } from '@/lib/cn';
import { socketClient } from '@/services/socket/client';
import { connectionStatus, reconnectAttempt, reconnectNextAt, reconnectWaitingFor, serverRestarting } from '@/state/session';
import { voiceStatus } from '@/state/voice';
import { arcadeView, openArcade } from '@/features/arcade/state';

/** Seconds until `at`, never below zero. */
const secondsUntil = (at: number | null, now: number): number | null => (at === null ? null : Math.max(0, Math.ceil((at - now) / 1000)));

/**
 * A thin strip at the top while the socket is down. Never a modal: the app stays
 * usable (typing queues, the call keeps going). It says what is happening, how
 * many attempts were made, when the next one is, and offers "Retry now".
 */
export const ConnectionBanner = () => {
  const status = connectionStatus.value;
  const [now, setNow] = useState(Date.now());
  const visible = status !== 'connected';

  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [visible]);

  if (!visible) return null;

  const attempt = reconnectAttempt.value;
  const waitingFor = reconnectWaitingFor.value;
  const restart = serverRestarting.value;
  const inVoice = voiceStatus.value === 'reconnecting';
  const wait = secondsUntil(reconnectNextAt.value, now);

  let text: string;
  if (status === 'connecting' && attempt === 0) {
    text = 'Connecting to server…';
  } else if (status === 'offline' || waitingFor === 'network') {
    text = 'No internet connection. Waiting for the network…';
  } else if (restart && (waitingFor === 'server' || attempt === 0)) {
    text = 'The server is restarting. Back in about ' + Math.max(1, Math.round(restart.expectedWaitMs / 1000)) + ' s…';
  } else if (wait !== null && wait > 0) {
    text = 'Connection lost. Attempt ' + (attempt + 1) + ' in ' + wait + ' s…';
  } else {
    text = attempt > 0 ? 'Reconnecting… (attempt ' + attempt + ')' : 'Connection lost. Reconnecting…';
  }
  if (inVoice) text += ' Your call stays up.';

  return (
    <div className="fixed top-0 right-0 left-0 z-[55] flex justify-center safe-top" role="status" aria-live="polite" data-connection-banner={status}>
      <div className={cn('mt-2 flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold shadow-pop animate-slide-up', status === 'offline' ? 'bg-live text-white' : 'bg-warning text-black')}>
        {status === 'offline' ? <WifiOff size={14} /> : <RefreshCw size={14} className="animate-spin motion-reduce:animate-none" />}
        <span>{text}</span>
        {status !== 'connecting' && (
          <button
            type="button"
            className="rounded-full bg-black/15 px-2 py-0.5 font-semibold hover:bg-black/25"
            onClick={() => socketClient.retryNow()}
            data-retry-now
          >
            Retry now
          </button>
        )}
        {status === 'offline' && !arcadeView.value && (
          <button
            type="button"
            className="flex items-center gap-1 rounded-full bg-black/15 px-2 py-0.5 font-semibold hover:bg-black/25"
            onClick={() => openArcade({ mode: 'local' })}
            data-play-offline
          >
            <Gamepad2 size={12} /> Play offline
          </button>
        )}
      </div>
    </div>
  );
};
