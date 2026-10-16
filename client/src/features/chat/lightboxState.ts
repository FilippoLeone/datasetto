import { signal } from '@preact/signals';
import type { Attachment } from '@/types/protocol';

export interface LightboxState {
  items: Attachment[];
  index: number;
  /** The element to give focus back to when the lightbox closes. */
  returnFocus: HTMLElement | null;
}

/** The picture viewer: the pictures of one message and which one is shown. */
export const lightbox = signal<LightboxState | null>(null);

export const openLightbox = (items: Attachment[], index: number, returnFocus: HTMLElement | null = null): void => {
  if (items.length === 0) return;
  lightbox.value = { items, index: Math.min(Math.max(index, 0), items.length - 1), returnFocus };
};

export const closeLightbox = (): void => {
  const current = lightbox.value;
  lightbox.value = null;
  current?.returnFocus?.focus?.();
};

/** Move to the previous (-1) or next (+1) picture, wrapping around. */
export const stepLightbox = (delta: number): void => {
  const current = lightbox.value;
  if (!current || current.items.length < 2) return;
  const count = current.items.length;
  lightbox.value = { ...current, index: (((current.index + delta) % count) + count) % count };
};
