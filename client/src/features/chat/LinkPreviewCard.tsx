import { useState } from 'preact/hooks';
import { X } from 'lucide-preact';
import { onExternalLinkClick } from '@/services/native/desktop';
import type { LinkPreview } from '@/types/protocol';

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

interface LinkPreviewCardProps {
  preview: LinkPreview | null | undefined;
  /** Show the remove control (own message, or moderation rights). */
  canRemove?: boolean;
  onRemove?: () => void;
}

/**
 * Compact card for the first link of a message: site, title, description and a thumbnail
 * when the page offers one. The thumbnail loads straight from the site (no referrer);
 * a broken one simply disappears.
 */
export const LinkPreviewCard = ({ preview, canRemove, onRemove }: LinkPreviewCardProps) => {
  const [imageBroken, setImageBroken] = useState(false);
  if (!preview) return null;
  const image = preview.image && !imageBroken ? preview.image : null;
  if (!preview.title && !preview.description && !image) return null;
  const title = preview.title ?? hostOf(preview.url);
  const imageOnly = !preview.title && !preview.description;

  return (
    <div className="link-card relative mt-1.5 flex max-w-[480px] gap-3 rounded-md border-l-4 border-brand bg-base/60 p-3 pr-8" data-link-preview>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-xs text-text-faint">{preview.siteName ?? hostOf(preview.url)}</span>
        <a
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          className="line-clamp-2 font-semibold text-link hover:underline"
          onClick={(event) => onExternalLinkClick(event, preview.url)}
        >
          {title}
        </a>
        {preview.description && <p className="mt-0.5 line-clamp-3 text-sm text-text-muted">{preview.description}</p>}
        {imageOnly && (
          <img
            src={image as string}
            alt=""
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
            className="mt-2 max-h-64 max-w-full rounded-sm object-contain"
            onError={() => setImageBroken(true)}
          />
        )}
      </div>
      {image && !imageOnly && (
        <img
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
          className="h-20 w-20 shrink-0 rounded-sm object-cover"
          onError={() => setImageBroken(true)}
        />
      )}
      {canRemove && onRemove && (
        <button
          type="button"
          aria-label="Remove preview"
          title="Remove preview"
          className="absolute top-1.5 right-1.5 rounded-sm p-1 text-text-faint hover:bg-hover hover:text-text-bright"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
};
