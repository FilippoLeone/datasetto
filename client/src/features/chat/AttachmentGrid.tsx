import { cn } from '@/lib/cn';
import { mediaUrl } from '@/lib/media';
import type { Attachment } from '@/types/protocol';
import { openLightbox } from './lightboxState';

/** Largest footprint of a single picture in the message column. */
const SINGLE_MAX_WIDTH = 420;
const SINGLE_MAX_HEIGHT = 340;

/**
 * The pictures of a message. One picture keeps its own shape (bounded), several form a
 * two-column grid of square tiles; the preview is shown (the original for GIFs so they
 * move) and the space is reserved from the known size so the list does not jump.
 */
export const AttachmentGrid = ({ attachments }: { attachments: Attachment[] | undefined }) => {
  if (!attachments || attachments.length === 0) return null;
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
