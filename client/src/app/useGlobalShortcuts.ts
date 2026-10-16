import { useEffect } from 'preact/hooks';
import { closeModal, modal, openModal } from '@/state/ui';
import { isAuthenticated } from '@/state/session';
import { voiceManager } from '@/features/voice/voiceManager';

const isTypingTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
};

/** App-wide keyboard shortcuts: Escape closes dialogs, Ctrl+Shift+M mutes, Ctrl+Shift+D deafens, push-to-talk. */
export const useGlobalShortcuts = (): void => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && modal.value && modal.value.type !== 'auth') {
        closeModal();
        return;
      }
      if (!isAuthenticated.value) return;

      if (event.ctrlKey && event.shiftKey && !event.altKey) {
        if (event.code === 'KeyM') {
          event.preventDefault();
          void voiceManager.toggleMute();
          return;
        }
        if (event.code === 'KeyD') {
          event.preventDefault();
          void voiceManager.toggleDeafen();
          return;
        }
        if (event.code === 'Comma') {
          event.preventDefault();
          openModal({ type: 'audioSettings' });
          return;
        }
      }
      if (!isTypingTarget(event.target)) voiceManager.handlePttKey(event, true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      voiceManager.handlePttKey(event, false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);
};
