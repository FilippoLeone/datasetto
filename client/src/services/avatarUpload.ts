import { runtimeUrls } from '@/lib/runtimeConfig';
import { sessionToken } from '@/state/session';
import type { Account } from '@/types/protocol';

/** Upload limit enforced by the server; the cropper keeps well under it. */
export const MAX_AVATAR_BYTES = 1024 * 1024;

interface AvatarResponse {
  avatarUrl: string | null;
  account: Account;
}

const request = async (method: 'POST' | 'DELETE', body?: Blob): Promise<AvatarResponse> => {
  const token = sessionToken.value;
  if (!token) throw new Error('Sign in first');
  const headers: Record<string, string> = { Authorization: 'Bearer ' + token };
  if (body) headers['Content-Type'] = body.type || 'application/octet-stream';
  const response = await fetch(runtimeUrls.apiBaseUrl + '/api/avatars', { method, headers, body, credentials: 'include' });
  const data = (await response.json().catch(() => ({}))) as Partial<AvatarResponse> & { error?: string };
  if (!response.ok) throw new Error(data.error || 'Upload failed (' + response.status + ')');
  return data as AvatarResponse;
};

/** Send the cropped image (PNG or WebP blob) to the server; resolves with the updated account. */
export const uploadAvatar = (image: Blob): Promise<AvatarResponse> => {
  if (image.size > MAX_AVATAR_BYTES) return Promise.reject(new Error('The image is too large (1 MB max)'));
  return request('POST', image);
};

export const deleteAvatar = (): Promise<AvatarResponse> => request('DELETE');
