import { signal } from '@preact/signals';
import { Info } from 'lucide-preact';
import { Button } from '@/components';
import { cn } from '@/lib/cn';
import { isIOS } from '@/lib/device';
import { Storage } from '@/lib/storage';

const DISMISSED_KEY = 'datasetto.iosVoiceNotice.v1';

/** "Got it" was tapped on this device; the notice stays away for good. */
export const iosVoiceNoticeDismissed = signal<boolean>(Storage.get<boolean>(DISMISSED_KEY, false) === true);

export const dismissIosVoiceNotice = (): void => {
  iosVoiceNoticeDismissed.value = true;
  Storage.set(DISMISSED_KEY, true);
};

/** Pure form of the decision: iPhone or iPad, and not dismissed yet. */
export const shouldShowIosVoiceNotice = (ios: boolean, dismissed: boolean): boolean => ios && !dismissed;

/**
 * What a web app cannot change about voice on an iPhone, said once: on the "Join voice" page
 * and, since a tap on a voice channel joins it at once, above the participants of the call.
 * The call pauses while Datasetto is not on screen (no background audio for web pages on
 * iOS), the phone picks speaker or earpiece, and a friend cannot be played above 100 %.
 */
export const IosVoiceNotice = ({ className }: { className?: string }) => {
  if (!shouldShowIosVoiceNotice(isIOS(), iosVoiceNoticeDismissed.value)) return null;
  return (
    <div className={cn('flex max-w-sm gap-2.5 rounded-md bg-base/60 p-3 text-left text-xs text-text-muted', className)} role="note" aria-label="Voice on iPhone" data-ios-voice-notice>
      <Info size={16} className="mt-0.5 shrink-0 text-link" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text-bright">Voice on iPhone and iPad</p>
        <p className="mt-1">
          The call runs while Datasetto is on screen. It pauses when you switch apps or lock the phone and picks up again when you come back. Your phone chooses
          between the speaker and the earpiece, and a friend cannot be made louder than 100 % here.
        </p>
        <Button size="sm" variant="ghost" className="mt-2" onClick={dismissIosVoiceNotice}>
          Got it
        </Button>
      </div>
    </div>
  );
};
