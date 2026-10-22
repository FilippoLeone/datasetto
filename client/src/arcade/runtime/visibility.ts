/**
 * The stage counts as visible only while the app is visible (tab shown, window not minimized, the
 * phone app in front), the stage is not minimized ("Back to call") and at least 10 % of it is on
 * screen (platform.md §10.3). The session calls `host.setVisible` and pauses or resumes the game
 * on every change, so a hidden game draws nothing and, online, gets only WebSocket pings.
 */
import { effect } from '@preact/signals';
import { arcadeSession } from '@/features/arcade/state';
import { appVisibility } from './p0';

export const watchStageVisibility = (stage: HTMLElement, cb: (visible: boolean) => void): (() => void) => {
  let app = appVisibility.visible;
  let inView = true;
  let minimized = false;
  let last: boolean | null = null;

  const emit = (): void => {
    const visible = app && inView && !minimized;
    if (visible === last) return;
    last = visible;
    cb(visible);
  };

  const offApp = appVisibility.subscribe((visible) => {
    app = visible;
    emit();
  });

  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        inView = entry.isIntersecting && entry.intersectionRatio >= 0.1;
        emit();
      },
      { threshold: [0, 0.1] },
    );
    io.observe(stage);
  }

  // Runs once now (the first emit) and again whenever the session's minimized flag changes.
  const stopEffect = effect(() => {
    minimized = arcadeSession.value?.minimized ?? false;
    emit();
  });

  return () => {
    offApp();
    stopEffect();
    io?.disconnect();
  };
};
