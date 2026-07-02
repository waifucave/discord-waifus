import { useState } from "react";
import { X } from "lucide-react";
import { addTag } from "./logic";

/**
 * Chip list + text entry for a `string[]` descriptor (e.g. `stopSequences`). Enter (or blur)
 * commits the current draft as a new chip via `addTag` (trims, dedupes, enforces `maxItems`);
 * the input disables once `maxItems` is reached. Removing the last chip and clearing the field
 * both go through `onChange([])` — `ModelParamsForm` is responsible for deleting the key
 * entirely from the config's `params` record when the array comes back empty.
 */
export function TagListField({
  value,
  maxItems,
  onChange
}: {
  value: string[];
  maxItems?: number;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const atMax = maxItems !== undefined && value.length >= maxItems;

  const commit = () => {
    const next = addTag(value, draft, maxItems);
    if (next !== value) onChange(next);
    setDraft("");
  };

  const remove = (index: number) => onChange(value.filter((_, i) => i !== index));

  return (
    <div className="tag-list">
      {value.length > 0 && (
        <div className="tag-list-chips">
          {value.map((tag, index) => (
            <span className="tag" key={`${tag}-${index}`}>
              {tag}
              <button
                type="button"
                className="tag-remove"
                onClick={() => remove(index)}
                aria-label={`Remove ${tag}`}
              >
                <X className="icon" />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className="input"
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        placeholder={atMax ? `Max ${maxItems} reached` : "Type a value, press Enter"}
        disabled={atMax}
      />
      {maxItems !== undefined && (
        <span className="tag-list-count">
          {value.length}/{maxItems}
        </span>
      )}
    </div>
  );
}
