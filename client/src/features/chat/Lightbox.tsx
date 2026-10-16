import { useEffect, useRef } from 'preact/hooks';
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-preact';
import { IconButton } from '@/components';
import { formatBytes } from '@/lib/format';
import { mediaUrl } from '@/lib/media';
import { MOTION, usePresence } from '@/lib/motion';
import { openExternal } from '@/services/native/desktop';
import { closeLightbox, lightbox, stepLightbox, type LightboxState } from './lightboxState';

const Viewer = ({ state }: { state: LightboxState }) => {
  const item = state.items[state.index];
  const many = state.items.length > 1;
  const stageRef = useRef<HTMLDivElement>(null);
  const original = mediaUrl(item.url);

  // Keys work wherever focus is while the viewer is open; nothing behind it sees them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeLightbox();
      else if (event.key === 'ArrowLeft') stepLightbox(-1);
      else if (event.key === 'ArrowRight') stepLightbox(1);
      else if (event.key === 'Home') lightbox.value = { ...state, index: 0 };
      else if (event.key === 'End') lightbox.value = { ...state, index: state.items.length - 1 };
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [state]);

  useEffect(() => {
    stageRef.current?.focus();
  }, []);

  // The neighbours are fetched ahead so stepping through feels instant.
  useEffect(() => {
    if (!many) return;
    for (const delta of [-1, 1]) {
      const next = state.items[(state.index + delta + state.items.length) % state.items.length];
      const image = new Image();
      image.src = mediaUrl(next.mime === 'image/gif' ? next.url : next.previewUrl);
    }
  }, [state, many]);

  const dimensions = item.width && item.height ? item.width + ' × ' + item.height : null;

  return (
    <div
      ref={stageRef}
      tabIndex={-1}
      className="lightbox-stage flex h-full w-full flex-col outline-none"
      onClick={(event) => {
        // A click on the dark backdrop closes; clicks on the picture and the controls do not.
        if (event.target === event.currentTarget) closeLightbox();
      }}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 safe-top">
        <div className="min-w-0 text-sm text-text-bright">
          <span className="block truncate font-medium">{item.fileName}</span>
          <span className="block truncate text-xs text-text-muted">
            {[dimensions, formatBytes(item.size), many ? state.index + 1 + ' of ' + state.items.length : null].filter(Boolean).join(' · ')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            label="Open original"
            size="md"
            onClick={(event) => {
              event.stopPropagation();
              openExternal(original);
            }}
          >
            <ExternalLink size={18} />
          </IconButton>
          <IconButton label="Close" size="md" onClick={closeLightbox} data-close>
            <X size={20} />
          </IconButton>
        </div>
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-2 sm:px-14"
        onClick={(event) => {
          if (event.target === event.currentTarget) closeLightbox();
        }}
      >
        {many && (
          <IconButton label="Previous picture" size="lg" className="absolute left-2 top-1/2 z-10 -translate-y-1/2 bg-black/40 text-white hover:bg-black/60" onClick={() => stepLightbox(-1)}>
            <ChevronLeft size={24} />
          </IconButton>
        )}
        <img
          key={item.id}
          src={mediaUrl(item.mime === 'image/gif' ? item.url : item.previewUrl)}
          alt={item.fileName}
          className="max-h-full max-w-full rounded-md object-contain shadow-modal select-none animate-fade-in"
          draggable={false}
        />
        {many && (
          <IconButton label="Next picture" size="lg" className="absolute right-2 top-1/2 z-10 -translate-y-1/2 bg-black/40 text-white hover:bg-black/60" onClick={() => stepLightbox(1)}>
            <ChevronRight size={24} />
          </IconButton>
        )}
      </div>
      {many && (
        <div className="flex justify-center gap-1.5 pb-3 safe-bottom" role="tablist" aria-label="Pictures">
          {state.items.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={index === state.index}
              aria-label={'Picture ' + (index + 1)}
              className={'h-2 w-2 rounded-full transition-colors ' + (index === state.index ? 'bg-white' : 'bg-white/35 hover:bg-white/60')}
              onClick={() => {
                lightbox.value = { ...state, index };
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Full-screen picture viewer for a message's attachments. Escape closes, arrow keys
 * step, the backdrop closes; focus returns to the thumbnail that opened it. Stays
 * mounted for its leave animation through lib/motion.ts (nothing animates under
 * reduced motion).
 */
export const LightboxHost = () => {
  const current = lightbox.value;
  const last = useRef<LightboxState | null>(null);
  if (current) last.current = current;
  const presence = usePresence(current !== null, MOTION.base);
  const shown = current ?? last.current;
  if (!presence.mounted || !shown) return null;
  return (
    <div data-state={presence.state} role="dialog" aria-modal="true" aria-label="Picture viewer" className="motion-lightbox fixed inset-0 z-[70] bg-black/90">
      <Viewer state={shown} />
    </div>
  );
};
