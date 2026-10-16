import { useEffect, useState } from 'preact/hooks';

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Content box size of an element, kept current through a ResizeObserver.
 * Returns a callback ref (so an element that mounts later, or is swapped for
 * another, is still measured) and the size, null until the first measurement.
 *
 *   const [gridRef, gridSize] = useElementSize();
 *   <div ref={gridRef}>…</div>
 */
export const useElementSize = (): [(node: HTMLElement | null) => void, ElementSize | null] => {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState<ElementSize | null>(null);
  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') {
      setSize(null);
      return;
    }
    const measure = () => {
      const next = { width: node.clientWidth, height: node.clientHeight };
      setSize((current) => (current && current.width === next.width && current.height === next.height ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, size];
};
