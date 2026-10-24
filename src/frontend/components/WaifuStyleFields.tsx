import type { WaifuVerbosity } from "../api/types";

// Cast editor controls for how a waifu talks (spec 8.2/8.6/11.3): reply length (`verbosity`), free
// text appended to her prompt (`customInstructions`), and whether her schedule is mentioned in the
// prompt. Pure helpers are exported so the counter/validation is testable without a DOM.

// Must match WaifuConfigSchema.customInstructions (z.string().max(4000), counted in UTF-16 units).
export const CUSTOM_INSTRUCTIONS_MAX = 4000;

export const VERBOSITY_OPTIONS: ReadonlyArray<{ value: WaifuVerbosity; label: string; example: string }> = [
  { value: "terse", label: "Terse", example: "One short line, like a quick chat message: \"lol same, that boss fight was brutal\"" },
  { value: "chatty", label: "Chatty", example: "One to three lines: a reaction plus a thought or a question back." },
  { value: "expressive", label: "Expressive", example: "Up to a short paragraph, with room for tangents and description." }
];

export type CustomInstructionsStatus = {
  length: number;
  label: string;
  over: boolean;
};

export function customInstructionsStatus(text: string | undefined): CustomInstructionsStatus {
  const length = (text ?? "").length;
  return { length, label: `${length} / ${CUSTOM_INSTRUCTIONS_MAX}`, over: length > CUSTOM_INSTRUCTIONS_MAX };
}

// Save is blocked while the custom instructions exceed the server limit (it would be a 400).
export function waifuStyleBlocksSave(draft: { customInstructions?: string }): boolean {
  return customInstructionsStatus(draft.customInstructions).over;
}

export function verbosityExample(value: WaifuVerbosity | undefined): string {
  return (VERBOSITY_OPTIONS.find((option) => option.value === (value ?? "terse")) ?? VERBOSITY_OPTIONS[0]).example;
}

export function WaifuStyleFields({
  verbosity,
  customInstructions,
  onChange
}: {
  verbosity: WaifuVerbosity | undefined;
  customInstructions: string | undefined;
  onChange: (patch: { verbosity?: WaifuVerbosity; customInstructions?: string }) => void;
}) {
  const status = customInstructionsStatus(customInstructions);
  return (
    <>
      <div className="cell fcell" style={{ flex: "none" }}>
        <label className="field-label" htmlFor="waifu-verbosity">Message length</label>
        <select
          id="waifu-verbosity"
          className="select"
          value={verbosity ?? "terse"}
          onChange={(e) => onChange({ verbosity: e.target.value as WaifuVerbosity })}
        >
          {VERBOSITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="field-hint">{verbosityExample(verbosity)}</span>
      </div>
      <div className="cell fcell" style={{ flex: "none" }}>
        <label className="field-label" htmlFor="waifu-custom-instructions">Custom instructions</label>
        <textarea
          id="waifu-custom-instructions"
          className="textarea"
          rows={5}
          value={customInstructions ?? ""}
          onChange={(e) => onChange({ customInstructions: e.target.value })}
          placeholder="Extra rules for how she talks or behaves (optional)…"
          aria-invalid={status.over}
        />
        <span className="field-hint" style={status.over ? { color: "var(--danger)" } : undefined}>
          <span className="custom-instructions-count">{status.label}</span>
          {status.over ? " — too long, shorten it to save" : " — added to her prompt after the persona"}
        </span>
      </div>
    </>
  );
}
