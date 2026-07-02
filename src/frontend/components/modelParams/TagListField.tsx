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

  // Gateway P6 Task 5 (draft-flush investigation): committing only on Enter/blur — and NOT on
  // every keystroke — was flagged as a possible race with the views' Save button (WaifusView.tsx
  // etc.): mousedown on Save fires `blur` (this commit) before `click` (the save handler), so if
  // React let the click's handler run against a stale pre-commit closure, a typed-but-unEntered
  // chip could be silently dropped from the very next save.
  //
  // Traced and REFUTED — this is a non-bug, proven from react-dom's own event-priority table
  // (node_modules/react-dom/cjs/react-dom-client.development.js, `getEventPriority`): both
  // "blur" and "click" are `DiscreteEventPriority`. React attaches one native listener per event
  // type at the root container (`addTrappedEventListener`), each independently wrapped by
  // `dispatchDiscreteEvent`, which sets the update priority to Discrete/Sync for the DURATION of
  // that single native event's dispatch. A Discrete-priority update is flushed synchronously
  // before that listener call returns control to the browser — this is the same guarantee that
  // has held since React 16's `unstable_batchedUpdates`/legacy sync-flush and is preserved for
  // React 18/19's concurrent root. So by the time the browser fires the separate, later `click`
  // event, the `commit()` above has already run to completion: `onChange(next)` bubbled through
  // `ModelParamsForm`'s `setParam` into the view's `setWaifu`/`setDraft`-equivalent state, and a
  // full re-render + commit has already happened. React's click listener then re-derives
  // `props.onClick` from the CURRENT (post-blur) fiber tree, so the Save handler it invokes is a
  // fresh closure over the already-updated config — not the stale pre-commit one. (Every Save
  // handler across the four ModelParamsForm consumers — WaifusView.tsx, ReviewerView.tsx,
  // OrchestratorView.tsx, StageManagerView.tsx — is a plain non-memoized `const save = async ()
  // => {...}` redefined every render for exactly this reason: it always closes over the latest
  // state.) Full trace: .superpowers/sdd/task-5-report.md.
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
