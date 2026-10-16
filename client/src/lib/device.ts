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
  return typeof window !== 'undefined' && !!(window as any).desktopAPI;
};

export const isCapacitor = (): boolean => {
  return typeof window !== 'undefined' && !!(window as any).Capacitor?.isNativePlatform?.();
};

export const isNativeApp = (): boolean => {
  return isElectron() || isCapacitor();
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
