/**
 * The profile form keeps two things apart that the account stores in one field: a picture the
 * user uploaded (served from our own /api/avatars path) and a link they typed. The uploaded path
 * must never appear in the URL input: it is relative, and a URL input only accepts absolute links,
 * so the form could not be saved while an uploaded picture was in use.
 */

/** Our own avatar files live under /api/avatars; anything else is an external link. */
export const isUploadedAvatar = (url: string | null | undefined): boolean => Boolean(url && url.startsWith('/api/avatars/'));

export interface AvatarFormState {
  /** The uploaded picture in use, or null. */
  uploadedUrl: string | null;
  /** What the URL field shows; an external link, possibly still being typed. */
  externalUrl: string;
}

/** Split the stored avatar URL into the uploaded picture and the typed link. */
export const avatarFormState = (current: string | null | undefined): AvatarFormState =>
  isUploadedAvatar(current) ? { uploadedUrl: current as string, externalUrl: '' } : { uploadedUrl: null, externalUrl: current ?? '' };

/** What the account should store: a typed link wins, then the uploaded picture, then nothing (generated avatar). */
export const effectiveAvatarUrl = ({ uploadedUrl, externalUrl }: AvatarFormState): string | null => externalUrl.trim() || uploadedUrl || null;
