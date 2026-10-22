/** Types for own-windows.js (CommonJS); the client's unit tests load the module through createRequire. */

export interface HelperWindowRef {
  /** BrowserWindow.getMediaSourceId(), e.g. "window:1050030:2". */
  mediaSourceId?: string | null;
  /** BrowserWindow.getNativeWindowHandle() (the HWND on Windows). */
  nativeHandle?: Uint8Array | null;
}

export interface CaptureSourceLike {
  id: string;
  name?: string;
}

export const OVERLAY_TITLE: string;
export const PICKER_TITLE: string;
export const HELPER_WINDOW_TITLES: readonly string[];

export function windowHandleOf(sourceId: unknown): string | null;
export function nativeHandleToString(buffer: Uint8Array | null | undefined): string | null;
export function helperWindowMatcher(
  windows: ReadonlyArray<HelperWindowRef | null | undefined>,
  titles?: readonly string[],
): (source: CaptureSourceLike | null | undefined) => boolean;
export function withoutHelperWindows<T extends CaptureSourceLike>(
  sources: readonly T[],
  windows: ReadonlyArray<HelperWindowRef | null | undefined>,
  titles?: readonly string[],
): T[];
