import type { ParamDescriptor } from "../../api/llm";
import { clampToDescriptor } from "./logic";

/**
 * Range slider + synced number input for a `number`/`int` descriptor that has both `min` and
 * `max` (callers are responsible for only rendering this when both bounds are present —
 * `ModelParamsForm` falls back to a plain `.input` number field otherwise).
 *
 * `value === undefined` means "unset" (the config has no key for this param yet): the number
 * input renders empty with `descriptor.default` as its placeholder, and the slider itself shows
 * at `descriptor.default` (or the range midpoint, if no default) purely as a visual starting
 * point — that visual position is NOT written back via `onChange` until the user actually
 * interacts with one of the two controls.
 */
export function RangeField({
  descriptor,
  value,
  onChange
}: {
  descriptor: ParamDescriptor & { min: number; max: number };
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  const step = descriptor.step ?? (descriptor.type === "int" ? 1 : 0.01);
  const fallback = typeof descriptor.default === "number" ? descriptor.default : (descriptor.min + descriptor.max) / 2;
  const sliderValue = value ?? fallback;

  return (
    <div className="range-field">
      <input
        type="range"
        className="range-slider"
        min={descriptor.min}
        max={descriptor.max}
        step={step}
        value={sliderValue}
        onChange={(e) => onChange(clampToDescriptor(descriptor, e.target.value))}
      />
      <input
        type="number"
        className="input range-number"
        min={descriptor.min}
        max={descriptor.max}
        step={step}
        value={value ?? ""}
        placeholder={descriptor.default !== undefined ? String(descriptor.default) : undefined}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === "" ? undefined : clampToDescriptor(descriptor, raw));
        }}
      />
    </div>
  );
}
