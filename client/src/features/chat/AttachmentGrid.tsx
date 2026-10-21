import { useState } from 'preact/hooks';
import { Film } from 'lucide-preact';
import { cn } from '@/lib/cn';
import { formatBytes, formatSeconds } from '@/lib/format';
import { mediaUrl } from '@/lib/media';
import type { Attachment } from '@/types/protocol';
import { openLightbox } from './lightboxState';

/** Largest footprint of a single picture or video in the message column. */
const SINGLE_MAX_WIDTH = 420;
const SINGLE_MAX_HEIGHT = 340;

/**
 * The pictures of a message. One picture keeps its own shape (bounded), several form a
 * two-column grid of square tiles; the preview is shown (the original for GIFs so they
 * move) and the space is reserved from the known size so the list does not jump.
 */
const PictureGrid = ({ attachments }: { attachments: Attachment[] }) => {
  const single = attachments.length === 1;
  return (
    <div
      className={cn('mt-1.5 grid gap-1', single ? 'grid-cols-1' : 'grid-cols-2')}
      style={single ? undefined : { maxWidth: SINGLE_MAX_WIDTH + 'px' }}
      data-attachments={attachments.length}
    >
      {attachments.map((attachment, index) => {
        const width = attachment.previewWidth ?? attachment.width ?? 4;
        const height = attachment.previewHeight ?? attachment.height ?? 3;
        const style = single
          ? { aspectRatio: width + ' / ' + height, maxWidth: 'min(100%, ' + Math.max(96, Math.min(width, SINGLE_MAX_WIDTH)) + 'px)', maxHeight: SINGLE_MAX_HEIGHT + 'px' }
          : { aspectRatio: '1 / 1' };
        return (
          <button
            key={attachment.id}
            type="button"
            style={style}
            className="group/tile relative block w-full overflow-hidden rounded-md bg-base/60 outline-none focus-visible:ring-2 focus-visible:ring-brand"
            aria-label={'Open ' + attachment.fileName}
            title={attachment.fileName}
            onClick={(event) => {
              event.stopPropagation();
              openLightbox(attachments, index, event.currentTarget as HTMLElement);
            }}
          >
            <img
              src={mediaUrl(attachment.mime === 'image/gif' ? attachment.url : attachment.previewUrl)}
              alt={attachment.fileName}
              width={width}
              height={height}
              loading="lazy"
              decoding="async"
              draggable={false}
              className={cn('h-full w-full transition-transform duration-200 ease-out group-hover/tile:scale-[1.02] motion-reduce:transition-none', single ? 'object-contain' : 'object-cover')}
            />
          </button>
        );
      })}
    </div>
  );
};

/**
 * A video of a message (a clip posted from the library): the browser's own player,
 * bounded like a single picture, with the file's name, size and length under it.
 * Only the header is fetched until it is played; the file URL carries the viewer's
 * media ticket like a picture's, and the server answers range requests so it seeks.
 */
const VideoAttachment = ({ attachment }: { attachment: Attachment }) => {
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const width = attachment.width ?? 16;
  const height = attachment.height ?? 9;
  return (
    <figure className="mt-1.5" data-attachment-video={attachment.id}>
      <video
        src={mediaUrl(attachment.url)}
        controls
        preload="metadata"
        playsInline
        className="block rounded-md bg-black"
        style={{ aspectRatio: width + ' / ' + height, width: 'min(100%, ' + Math.max(160, Math.min(width, SINGLE_MAX_WIDTH)) + 'px)', maxHeight: SINGLE_MAX_HEIGHT + 'px' }}
        onLoadedMetadata={(event) => {
          const duration = (event.currentTarget as HTMLVideoElement).duration;
          if (Number.isFinite(duration) && duration > 0) setDurationMs(duration * 1000);
        }}
      />
      <figcaption className="mt-0.5 flex items-center gap-1 text-xs text-text-faint" title={attachment.fileName}>
        <Film size={12} className="shrink-0" aria-hidden="true" />
        <span className="truncate">{attachment.fileName}</span>
        <span className="shrink-0">· {formatBytes(attachment.size)}</span>
        {durationMs !== null && <span className="shrink-0">· {formatSeconds(durationMs)}</span>}
      </figcaption>
    </figure>
  );
};

/** What a message carries: its pictures as a grid (they share the lightbox), then each video with its own player. */
export const AttachmentGrid = ({ attachments }: { attachments: Attachment[] | undefined }) => {
  if (!attachments || attachments.length === 0) return null;
  const pictures = attachments.filter((attachment) => attachment.kind !== 'video');
  const videos = attachments.filter((attachment) => attachment.kind === 'video');
  return (
    <>
      {pictures.length > 0 && <PictureGrid attachments={pictures} />}
      {videos.map((video) => (
        <VideoAttachment key={video.id} attachment={video} />
      ))}
    </>
  );
};
