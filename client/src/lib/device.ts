export type DeviceKind = 'ios' | 'android' | 'desktop';

const getNavigator = (): Navigator | undefined => {
  if (typeof navigator === 'undefined') {
    return undefined;
  }
  return navigator;
};

const getUserAgent = (): string => {
  const nav = getNavigator();
  const ua = nav?.userAgent || nav?.vendor || '';
  return ua.toLowerCase();
};

export const isIOS = (): boolean => {
  const ua = getUserAgent();
  if (/iphone|ipad|ipod/.test(ua)) {
    return true;
  }

  const nav = getNavigator();
  if (!nav) {
    return false;
  }

  const platform = nav.platform?.toLowerCase() ?? '';
  if (/iphone|ipad|ipod/.test(platform)) {
    return true;
  }

  // iPadOS 13+ reports as Mac, but has touch points
  return platform === 'macintel' && Number(nav.maxTouchPoints ?? 0) > 1;
};

export const isAndroid = (): boolean => {
  const ua = getUserAgent();
  return ua.includes('android');
};

export const isMobileDevice = (): boolean => {
  if (isIOS() || isAndroid()) {
    return true;
  }

  const ua = getUserAgent();
  return /mobile/.test(ua);
};

export const isElectron = (): boolean => {
  return typeof window !== 'undefined' && Boolean(window.desktopAPI);
};

export const isCapacitor = (): boolean => {
  return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true;
};

/** The primary input is a finger: no hover and an imprecise pointer (phones, tablets). */
export const isTouchPrimary = (): boolean => {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
};

/**
 * Whether this runtime can capture a screen: the Electron picker or getDisplayMedia.
 * Mobile WebViews (Android, iOS) have neither, so share buttons are hidden there.
 */
export const canCaptureScreen = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (window.desktopAPI?.pickScreenshareSource) return true;
  const devices = typeof navigator !== 'undefined' ? (navigator.mediaDevices as (MediaDevices & { getDisplayMedia?: unknown }) | undefined) : undefined;
  return typeof devices?.getDisplayMedia === 'function';
};

export const isNativeApp = (): boolean => {
  return isElectron() || isCapacitor();
};

/** Opened from the home screen: `display-mode: standalone`, or Safari's `navigator.standalone` on iOS. */
export const isStandaloneDisplay = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
};

export const detectDeviceKind = (): DeviceKind => {
  if (isIOS()) {
    return 'ios';
  }
  if (isAndroid()) {
    return 'android';
  }
  return 'desktop';
};

export const applyDeviceClasses = (root: HTMLElement | null | undefined): void => {
  if (!root) {
    return;
  }

  const kind = detectDeviceKind();
  root.classList.add(`device-${kind}`);
  if (isMobileDevice()) {
    root.classList.add('device-mobile');
  } else {
    root.classList.add('device-desktop');
  }
};
