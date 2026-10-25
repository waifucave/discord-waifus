// Cast editor controls for how a waifu talks (spec 8.2/8.6/11.3): free text appended to her prompt
// (`customInstructions`), and whether her schedule is mentioned in the prompt. Pure helpers are exported so the counter/validation is testable without a DOM.

// Must match WaifuConfigSchema.customInstructions (z.string().max(4000), counted in UTF-16 units).
export const CUSTOM_INSTRUCTIONS_MAX = 4000;

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

export function WaifuStyleFields({
  customInstructions,
  onChange
}: {
  customInstructions: string | undefined;
  onChange: (patch: { customInstructions?: string }) => void;
}) {
  const status = customInstructionsStatus(customInstructions);
  return (
    <>
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
