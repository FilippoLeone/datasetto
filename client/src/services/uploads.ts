import { runtimeUrls } from '@/lib/runtimeConfig';
import { sessionToken } from '@/state/session';
import type { Attachment } from '@/types/protocol';

export interface UploadHandle {
  /** Resolves with the stored attachment; rejects with an Error whose message can be shown. */
  done: Promise<Attachment>;
  abort: () => void;
}

/**
 * Send one file (a picture from the composer, a clip from the library) to
 * `POST /api/uploads` (multipart). XMLHttpRequest because `fetch` has no upload
 * progress. The server sniffs the bytes and answers with the attachment to
 * reference from the next message.
 */
export const uploadFile = (file: File, onProgress?: (fraction: number) => void): UploadHandle => {
  const xhr = new XMLHttpRequest();
  const done = new Promise<Attachment>((resolve, reject) => {
    const token = sessionToken.value;
    if (!token) {
      reject(new Error('Sign in first'));
      return;
    }
    const body = new FormData();
    body.append('files', file, file.name || 'file');
    xhr.open('POST', runtimeUrls.apiBaseUrl + '/api/uploads');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.withCredentials = true;
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(Math.min(1, event.loaded / event.total));
    };
    xhr.onerror = () => reject(new Error('The upload failed. Check your connection.'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.ontimeout = () => reject(new Error('The upload timed out'));
    xhr.onload = () => {
      const data = (xhr.response ?? {}) as { attachments?: Attachment[]; error?: string };
      const attachment = data.attachments?.[0];
      if (xhr.status >= 200 && xhr.status < 300 && attachment) {
        resolve(attachment);
        return;
      }
      reject(new Error(data.error || 'Upload failed (' + xhr.status + ')'));
    };
    // A clip of tens of megabytes on a slow uplink takes a while; pictures finish long before this.
    xhr.timeout = 10 * 60_000;
    xhr.send(body);
  });
  return { done, abort: () => xhr.abort() };
};

/** The message is rejected by `uploadFile` when the user cancelled it. */
export const UPLOAD_CANCELLED = 'Upload cancelled';
