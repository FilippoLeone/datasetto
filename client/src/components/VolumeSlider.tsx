import { cn } from '@/lib/cn';

interface VolumeSliderProps {
  /** Percent, 0..max. */
  value: number;
  /** 100 for media that cannot play louder than it is, 200 where a boost is possible. */
  max?: 100 | 200;
  /** Drag and arrow-key step, in percent. */
  step?: number;
  /** Accessible name, e.g. "Volume for bob" or "Stream volume". */
  label: string;
  onChange: (percent: number) => void;
  /** Show the percentage after the track. */
  showValue?: boolean;
  disabled?: boolean;
  className?: string;
  /** Width of the track (a Tailwind width class); it fills the row by default. */
  trackClassName?: string;
  valueClassName?: string;
}

/**
 * The volume control used everywhere a slider sets how loud something plays: a real range
 * input (arrow keys step, Home and End go to the ends, the value is announced as a
 * percentage) with the percentage beside it. The thumb grows on touch screens (.range-input).
 */
export const VolumeSlider = ({ value, max = 100, step = 5, label, onChange, showValue, disabled, className, trackClassName, valueClassName }: VolumeSliderProps) => {
  const percent = Math.round(Math.min(max, Math.max(0, value)));
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <input
        type="range"
        className={cn('range-input', trackClassName ?? 'min-w-0 flex-1')}
        min={0}
        max={max}
        step={step}
        value={percent}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={percent + '%'}
        title={label}
        data-volume-slider
        onInput={(event) => onChange(Number((event.target as HTMLInputElement).value))}
      />
      {showValue && (
        <span className={cn('w-10 shrink-0 text-right tabular-nums', valueClassName)} aria-hidden="true" data-volume-value>
          {percent}%
        </span>
      )}
    </span>
  );
};
