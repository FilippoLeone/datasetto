interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export const Slider = ({ label, value, min, max, step = 1, format, onChange, disabled }: SliderProps) => (
  <label className="block py-2">
    <span className="mb-1.5 flex items-center justify-between text-sm">
      <span className="font-medium text-text-bright">{label}</span>
      <span className="tabular-nums text-text-muted">{format ? format(value) : value}</span>
    </span>
    <input
      type="range"
      className="range-input"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onInput={(event) => onChange(Number((event.target as HTMLInputElement).value))}
    />
  </label>
);
