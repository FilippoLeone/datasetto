import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { Logo } from './Logo';

describe('Logo', () => {
  let root: HTMLDivElement;

  afterEach(() => {
    render(null, root);
    root.remove();
  });

  it('gives every instance its own planet gradient', () => {
    root = document.createElement('div');
    document.body.append(root);
    act(() => {
      render(
        <>
          <Logo size={22} />
          <Logo size={34} />
        </>,
        root
      );
    });

    const svgs = [...root.querySelectorAll('svg')];
    expect(svgs.map((svg) => svg.getAttribute('width'))).toEqual(['22', '34']);
    const ids = svgs.map((svg) => svg.querySelector('linearGradient')?.id);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
    svgs.forEach((svg, i) => {
      // The two planet pieces point at this instance's gradient; the ring is a flat colour.
      const fills = [...svg.querySelectorAll('path')].map((path) => path.getAttribute('fill'));
      expect(fills).toEqual([`url(#${ids[i]})`, `url(#${ids[i]})`, '#12A89D']);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      // Preact 11 writes camelCase SVG props verbatim, so the stops must use stop-color.
      const stops = [...svg.querySelectorAll('stop')].map((stop) =>
        stop.getAttribute('stop-color')
      );
      expect(stops).toEqual(['#FFAE3B', '#FF6A3D']);
    });
  });
});
