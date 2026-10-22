/**
 * The phase 0 interfaces the Arcade builds on (docs/arcade/plan.md §2.6.1), in one place: the
 * frame scheduler, merged app visibility, the shared Capacitor app-state listener, the desktop
 * shell's attention request and the constrained-link signal. They are the app's own modules
 * (phase 0 PRs #28, #29, #31 and #32); game chunks keep importing `frames` from here.
 */
export { frames, frameTimers, type FrameOpts, type Frames } from '@/lib/frames';
export { appVisibility, type AppVisibility } from '@/services/native/appVisibility';
export { onAppStateChange } from '@/services/native/appState';
export { requestDesktopAttention } from '@/services/native/desktop';
export { linkConstrained } from '@/services/voice/linkConstraint';
