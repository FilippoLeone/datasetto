import { isCapacitor } from '@/lib/device';

/**
 * Getting a saved clip out of the app as a file.
 *
 * - Browser and desktop app: a download link (the desktop shell's download handling
 *   shows its save dialog).
 * - Android app (Capacitor): the WebView does not download blob: URLs, so the file is
 *   written to the phone's Documents folder (Documents/Datasetto) with the Filesystem
 *   plugin and the share sheet is opened on it, from where it can also be sent on.
 */
export type DownloadOutcome = 'download' | 'saved' | 'shared';

/** Size of the slices written to the phone at a time (base64 grows them by a third). */
const NATIVE_CHUNK_BYTES = 1024 * 1024;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(offset, offset + step)));
  }
  return btoa(binary);
};

const downloadInBrowser = (blob: Blob, fileName: string): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser (and the desktop shell's save dialog) time to pick the blob up.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

/** Folder under the phone's Documents where clips are written. */
export const ANDROID_CLIPS_FOLDER = 'Datasetto';

const saveOnDevice = async (blob: Blob, fileName: string): Promise<DownloadOutcome> => {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const path = ANDROID_CLIPS_FOLDER + '/' + fileName;
  const write = async (directory: (typeof Directory)[keyof typeof Directory]): Promise<string> => {
    let uri = '';
    for (let offset = 0; offset < blob.size || offset === 0; offset += NATIVE_CHUNK_BYTES) {
      const data = toBase64(new Uint8Array(await blob.slice(offset, offset + NATIVE_CHUNK_BYTES).arrayBuffer()));
      if (offset === 0) uri = (await Filesystem.writeFile({ path, data, directory, recursive: true })).uri;
      else await Filesystem.appendFile({ path, data, directory });
      if (blob.size === 0) break;
    }
    return uri;
  };
  let uri: string;
  let outcome: DownloadOutcome = 'saved';
  try {
    uri = await write(Directory.Documents);
  } catch {
    // Public Documents refused (an odd Android build): keep it in the app's own storage and only share.
    uri = await write(Directory.Cache);
    outcome = 'shared';
  }
  try {
    const { Share } = await import('@capacitor/share');
    await Share.share({ title: fileName, files: [uri], dialogTitle: 'Share clip' });
  } catch (error) {
    // Closing the share sheet without picking anything is not a failure: the file is saved.
    if (outcome === 'shared' && !/cancel/i.test(String((error as { message?: string })?.message ?? error))) throw error;
  }
  return outcome;
};

export const downloadClipFile = async (blob: Blob, fileName: string): Promise<DownloadOutcome> => {
  if (isCapacitor()) return saveOnDevice(blob, fileName);
  downloadInBrowser(blob, fileName);
  return 'download';
};
