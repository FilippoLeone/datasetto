import { useEffect } from 'preact/hooks';
import { classifySwipe, drawerSwipeAction, type GesturePoint } from '@/lib/gestures';
import { searchOpen } from '@/state/search';
import { isMobile, isPhone, membersOpen, modal, sidebarOpen } from '@/state/ui';

/**
 * The finger started on something that scrolls or drags sideways itself (a
 * thumbnail strip, a slider, a video, the avatar cropper): leave the gesture
 * to it.
 */
const ownsHorizontalGestures = (target: EventTarget | null): boolean => {
  let node = target instanceof Element ? target : null;
  while (node && node !== document.body) {
    const tag = node.tagName;
    if (tag === 'VIDEO' || tag === 'CANVAS' || (tag === 'INPUT' && (node as HTMLInputElement).type === 'range')) return true;
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') return true;
    }
    node = node.parentElement;
  }
  return false;
};

/**
 * Swipe right anywhere in the main area to open the channel drawer, left for
 * the member drawer, and the opposite way on an open drawer to close it.
 * Threshold-based (lib/gestures.ts), passive listeners, so scrolling and the
 * system's own edge gestures are untouched.
 */
export const useDrawerSwipe = (): void => {
  useEffect(() => {
    let start: GesturePoint | null = null;
    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || ownsHorizontalGestures(event.target)) {
        start = null;
        return;
      }
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY, t: event.timeStamp };
    };
    const onEnd = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.changedTouches[0];
      const direction = classifySwipe(start, { x: touch.clientX, y: touch.clientY, t: event.timeStamp });
      start = null;
      const action = drawerSwipeAction(direction, {
        phone: isPhone.value,
        mobile: isMobile.value,
        sidebarOpen: sidebarOpen.value,
        membersOpen: membersOpen.value,
        locked: modal.value !== null || searchOpen.value || document.querySelector('[data-sheet]') !== null,
      });
      if (action === 'open-sidebar') sidebarOpen.value = true;
      else if (action === 'close-sidebar') sidebarOpen.value = false;
      else if (action === 'open-members') membersOpen.value = true;
      else if (action === 'close-members') membersOpen.value = false;
    };
    const onCancel = () => {
      start = null;
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onCancel);
    };
  }, []);
};
