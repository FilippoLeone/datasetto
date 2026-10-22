import { useId } from 'preact/hooks';
import { LOGO_MARK } from './logoMark';

interface LogoProps {
  size?: number;
  className?: string;
}

/** The Datasetto mark (a planet with a ring), drawn from brand/orbit.mjs. Decorative: pair it with the name. */
export const Logo = ({ size = 24, className }: LogoProps) => {
  // A per-instance gradient id, so two logos on one page never share (or lose) a definition.
  const gradient = `logo-${useId().replace(/[^\w-]/g, '')}`;
  const { gradient: g, colors } = LOGO_MARK;
  return (
    <svg
      viewBox={LOGO_MARK.viewBox}
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient
          id={gradient}
          gradientUnits="userSpaceOnUse"
          x1={g.x1}
          y1={g.y1}
          x2={g.x2}
          y2={g.y2}
        >
          <stop offset="0" stop-color={colors.planetFrom} />
          <stop offset="1" stop-color={colors.planetTo} />
        </linearGradient>
      </defs>
      <path fill={`url(#${gradient})`} d={LOGO_MARK.body} />
      <path fill={`url(#${gradient})`} d={LOGO_MARK.sliver} />
      <path fill={colors.ring} d={LOGO_MARK.ring} />
    </svg>
  );
};
