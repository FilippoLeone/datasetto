import type { Attachment } from '@/types/protocol';

/** Where a picture in the composer stands: being sent to the server, ready to post, or failed. */
export type DraftStatus = 'uploading' | 'ready' | 'error';

export interface AttachmentDraft {
  /** Local id (the server id is in `attachment` once uploaded). */
  key: string;
  file: File;
  /** Object URL for the thumbnail; revoke it when the draft goes. */
  previewUrl: string;
  status: DraftStatus;
  /** 0 to 1 while uploading. */
  progress: number;
  attachment: Attachment | null;
  error: string | null;
}

export interface AttachmentLimits {
  maxBytes: number;
  maxFiles: number;
  acceptedTypes: readonly string[];
}

export interface AddFilesResult {
  drafts: AttachmentDraft[];
  /** What was not added and why, in file order. */
  rejected: Array<{ file: File; reason: string }>;
}

const formatMb = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  return (Number.isInteger(mb) ? mb : mb.toFixed(1)) + ' MB';
};

let counter = 0;

/** Pictures only; browsers report an empty type for some drag sources, so the name's extension counts too. */
export const isAcceptedImage = (file: File, acceptedTypes: readonly string[]): boolean => {
  if (file.type) return acceptedTypes.includes(file.type.toLowerCase());
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const byExtension: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  return extension !== undefined && acceptedTypes.includes(byExtension[extension] ?? '');
};

/**
 * Add files to the composer's picture strip. Files that are not accepted pictures,
 * too large, or beyond the per-message cap are reported back instead of added.
 */
export const addFiles = (
  drafts: readonly AttachmentDraft[],
  files: readonly File[],
  limits: AttachmentLimits,
  makeUrl: (file: File) => string = (file) => URL.createObjectURL(file),
): AddFilesResult => {
  const next = [...drafts];
  const rejected: AddFilesResult['rejected'] = [];
  for (const file of files) {
    if (!isAcceptedImage(file, limits.acceptedTypes)) {
      rejected.push({ file, reason: 'Only PNG, JPEG, WebP and GIF pictures can be shared' });
      continue;
    }
    if (file.size === 0) {
      rejected.push({ file, reason: 'The file is empty' });
      continue;
    }
    if (file.size > limits.maxBytes) {
      rejected.push({ file, reason: 'Pictures must be ' + formatMb(limits.maxBytes) + ' or smaller' });
      continue;
    }
    if (next.length >= limits.maxFiles) {
      rejected.push({ file, reason: 'At most ' + limits.maxFiles + ' pictures per message' });
      continue;
    }
    counter += 1;
    next.push({ key: 'draft-' + Date.now() + '-' + counter, file, previewUrl: makeUrl(file), status: 'uploading', progress: 0, attachment: null, error: null });
  }
  return { drafts: next, rejected };
};

export const updateDraft = (drafts: readonly AttachmentDraft[], key: string, patch: Partial<AttachmentDraft>): AttachmentDraft[] =>
  drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft));

export const removeDraft = (drafts: readonly AttachmentDraft[], key: string): AttachmentDraft[] => drafts.filter((draft) => draft.key !== key);

/** A message can go out with text, with pictures, or both; never while a picture is still uploading or failed. */
export const canSend = (text: string, drafts: readonly AttachmentDraft[]): boolean => {
  if (drafts.some((draft) => draft.status !== 'ready')) return false;
  return text.trim().length > 0 || drafts.length > 0;
};

/** Server ids of the uploaded pictures, in strip order. */
export const attachmentIds = (drafts: readonly AttachmentDraft[]): string[] =>
  drafts.map((draft) => draft.attachment?.id).filter((id): id is string => typeof id === 'string');

/** "Sent a picture", "Sent 2 videos", "Sent 3 files": what a message without text carries, for notifications. */
export const attachmentSummary = (attachments: ReadonlyArray<Pick<Attachment, 'kind'>> | undefined): string => {
  const count = attachments?.length ?? 0;
  if (count === 0 || !attachments) return '';
  const videos = attachments.filter((attachment) => attachment.kind === 'video').length;
  const noun = videos === count ? 'video' : videos === 0 ? 'picture' : 'file';
  return count === 1 ? 'Sent a ' + noun : 'Sent ' + count + ' ' + noun + 's';
};

/** The picture files of a paste or drop, if any. */
export const filesFromTransfer = (data: DataTransfer | null | undefined): File[] => {
  if (!data) return [];
  const files: File[] = [];
  if (data.items && data.items.length > 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length > 0) return files;
  }
  return Array.from(data.files ?? []);
};

/** Does a drag carry files at all (as opposed to text)? Checked on dragenter, before the files are readable. */
export const transferHasFiles = (data: DataTransfer | null | undefined): boolean => {
  if (!data) return false;
  return Array.from(data.types ?? []).includes('Files');
};
