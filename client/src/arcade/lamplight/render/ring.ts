/**
 * The turn ring (lamplight.md §14.3): its own 72 × 72 overlay canvas over the seat whose clock is
 * running, redrawn at 10 Hz by the module's single `setTimeout` chain, and only while a clock runs
 * and the table is visible. Amber while the action clock runs, blue during the time bank, red in
 * the last 5 s.
 */
export const RING = 72;

export interface Ring {
  /** Place it over the avatar centred at (x, y), or hide it (null). */
  place(at: { x: number; y: number } | null): void;
  /** Draw the remaining fraction. */
  draw(fraction: number, ms: number, bank: boolean): void;
  dispose(): void;
}

export const createRing = (parent: HTMLElement, dpr: () => number): Ring => {
  const canvas = document.createElement('canvas');
  canvas.className = 'll-ring';
  canvas.style.cssText = 'position:absolute;width:72px;height:72px;pointer-events:none;display:none;';
  parent.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let sized = 0;
  return {
    place(at) {
      if (!at) {
        canvas.style.display = 'none';
        return;
      }
      canvas.style.display = 'block';
      canvas.style.left = Math.round(at.x - RING / 2) + 'px';
      canvas.style.top = Math.round(at.y - RING / 2) + 'px';
    },
    draw(fraction, ms, bank) {
      if (!ctx) return;
      const d = dpr();
      if (sized !== d) {
        canvas.width = canvas.height = Math.round(RING * d);
        sized = d;
      }
      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.clearRect(0, 0, RING, RING);
      ctx.lineCap = 'round';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(RING / 2, RING / 2, RING / 2 - 10, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.stroke();
      const f = Math.max(0, Math.min(1, fraction));
      ctx.beginPath();
      ctx.arc(RING / 2, RING / 2, RING / 2 - 10, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
      ctx.strokeStyle = ms <= 5000 ? '#e5484d' : bank ? '#4ea1ff' : '#f2b84b';
      ctx.stroke();
    },
    dispose() {
      canvas.width = canvas.height = 0;
      canvas.remove();
    },
  };
};
