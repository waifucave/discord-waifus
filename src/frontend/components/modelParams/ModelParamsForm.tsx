import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ApiError } from "../../api/client";
import type { ParamDescriptor, ResolvedModel } from "../../api/llm";
import { llmModel, llmValidate } from "../../api/llm";
import { Notice } from "../Notice";
import { Pill } from "../Pill";
import { Skeleton } from "../Skeleton";
import { Toggle } from "../Toggle";
import { buildParamControls, clampToDescriptor, paramLabel, violationsByParam, type ParamControl } from "./logic";
import { RangeField } from "./RangeField";
import { TagListField } from "./TagListField";

type DocState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error" }
  | { status: "ready"; doc: ResolvedModel };

type ValidateWarning = { code: string; param?: string; message?: string };

const SECTIONS: Array<{ group: ParamControl["group"]; title: string }> = [
  { group: "sampling", title: "Sampling" },
  { group: "reasoning", title: "Reasoning" },
  { group: "other", title: "Advanced" }
];

/**
 * Descriptor-driven params editor: fetches the gateway's capability doc for `(providerId,
 * modelId)`, renders one control per `buildParamControls(doc)` entry grouped under
 * Sampling/Reasoning/Advanced, and live-validates edits against `POST /v1/validate` (debounced).
 *
 * `value` is the config's `params` record as-is — controls read straight from it and never see
 * a locally-buffered copy, so an untouched control has no key in `value` (its descriptor.default
 * only ever shows as a placeholder, never gets written implicitly).
 */
export function ModelParamsForm({
  providerId,
  modelId,
  value,
  onChange,
  onValidity
}: {
  providerId: string | null;
  modelId: string | null;
  value: Record<string, unknown>;
  onChange: (params: Record<string, unknown>) => void;
  onValidity?: (ok: boolean) => void;
}): ReactElement | null {
  const [docState, setDocState] = useState<DocState>({ status: "loading" });
  const [violations, setViolations] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<ValidateWarning[]>([]);

  // Doc fetch: llmModel() is already Map-memoized (see api/llm.ts), so this is a plain
  // useEffect+state load with a stale-closure guard rather than a real AbortController — a
  // superseded (providerId, modelId) pair just has its late resolution ignored. Also clears any
  // violations/warnings carried over from the previous (providerId, modelId) pair so a stale
  // error/warning for a field that doesn't exist on the new model can't flash before the
  // debounced re-validate below lands.
  useEffect(() => {
    setViolations({});
    setWarnings([]);
    if (!providerId || !modelId) return;
    let stale = false;
    setDocState({ status: "loading" });
    llmModel(providerId, modelId)
      .then((doc) => {
        if (!stale) setDocState({ status: "ready", doc });
      })
      .catch((err: unknown) => {
        if (stale) return;
        // A 404 means the stored (providerId, modelId) pair is genuinely unknown to the gateway
        // registry (e.g. a stale/removed model id) — the existing "capability doc unavailable"
        // state. Anything else (network blip, 5xx, etc.) is transient, so it gets a distinct
        // message pointing at retrying rather than implying the model itself is invalid.
        if (err instanceof ApiError && err.status === 404) {
          setDocState({ status: "not-found" });
        } else {
          setDocState({ status: "error" });
        }
      });
    return () => {
      stale = true;
    };
  }, [providerId, modelId]);

  // Bumped on every debounced validate kickoff; a resolving/rejecting call only applies its
  // result if it's still the most recent one, guarding against an out-of-order response from an
  // earlier, slower request landing after a newer one.
  const requestSeq = useRef(0);
  const onValidityRef = useRef(onValidity);
  onValidityRef.current = onValidity;

  useEffect(() => {
    if (!providerId || !modelId) return;
    const seq = ++requestSeq.current;
    const timer = setTimeout(() => {
      llmValidate({ provider: providerId, model: modelId, params: value })
        .then((result) => {
          if (requestSeq.current !== seq) return;
          setViolations(violationsByParam(result.violations));
          setWarnings(result.warnings);
          onValidityRef.current?.(result.ok);
        })
        .catch((err: unknown) => {
          if (requestSeq.current !== seq) return;
          // eslint-disable-next-line no-console
          console.error("llmValidate failed", err);
          // Server-side write validation is the backstop — a transient validate-fetch failure
          // must never block editing.
          onValidityRef.current?.(true);
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [providerId, modelId, value]);

  if (!providerId || !modelId) return null;

  if (docState.status === "loading") {
    return <Skeleton height={160} />;
  }
  if (docState.status === "not-found") {
    return (
      <Notice tone="err">
        capability doc unavailable for {providerId}/{modelId}
      </Notice>
    );
  }
  if (docState.status === "error") {
    return <Notice tone="err">could not load capability doc — retry by reselecting the model</Notice>;
  }

  // "map" descriptors have no UI (brief: "map -> skip"); filtered here rather than in
  // buildParamControls so the pure ordering/grouping list stays a full, honest reflection of the
  // doc for any other consumer.
  const controls = buildParamControls(docState.doc).filter((control) => control.descriptor.type !== "map");

  const setParam = (key: string, next: unknown) => {
    const nextValue = { ...value };
    if (next === undefined || next === "") {
      delete nextValue[key];
    } else {
      nextValue[key] = next;
    }
    onChange(nextValue);
  };

  return (
    <div className="model-params-form">
      {warnings.length > 0 && (
        <Notice tone="warn">
          <ul className="model-params-warnings">
            {warnings.map((warning, index) => (
              <li key={index}>
                {warning.message ?? `${warning.code}${warning.param ? ` (${warning.param})` : ""}`}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {SECTIONS.map(({ group, title }) => {
        const groupControls = controls.filter((control) => control.group === group);
        if (groupControls.length === 0) return null;
        return (
          <section className="section" key={group}>
            <h3 className="section-title">{title}</h3>
            <div className="grid grid-2">
              {groupControls.map((control) => (
                <ParamField
                  key={control.key}
                  control={control}
                  value={value[control.key]}
                  error={violations[control.key]}
                  onChange={(next) => setParam(control.key, next)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ParamField({
  control,
  value,
  error,
  onChange
}: {
  control: ParamControl;
  value: unknown;
  error?: string;
  onChange: (next: unknown) => void;
}) {
  const { key, descriptor, unverified } = control;

  return (
    <div className="field">
      <label className="field-label">
        {paramLabel(key)}
        {unverified && <Pill tone="warn">unverified</Pill>}
      </label>
      <ParamControlInput descriptor={descriptor} value={value} onChange={onChange} />
      {unverified && <span className="field-hint">not enforced — probe pending</span>}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

function ParamControlInput({
  descriptor,
  value,
  onChange
}: {
  descriptor: ParamDescriptor;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  switch (descriptor.type) {
    case "boolean":
      return (
        <div className="toggle-field">
          <Toggle
            checked={typeof value === "boolean" ? value : Boolean(descriptor.default)}
            onChange={(next) => onChange(next)}
          />
          {typeof value === "boolean" && (
            <button type="button" className="btn ghost sm" onClick={() => onChange(undefined)}>
              reset
            </button>
          )}
        </div>
      );
    case "enum":
      return (
        <select
          className="select"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        >
          <option value="">
            {descriptor.default !== undefined ? `— default (${String(descriptor.default)}) —` : "— unset —"}
          </option>
          {(descriptor.values ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case "string[]":
      return (
        <TagListField
          value={Array.isArray(value) ? (value as string[]) : []}
          maxItems={descriptor.maxItems}
          onChange={(next) => onChange(next.length === 0 ? undefined : next)}
        />
      );
    case "string":
      return (
        <input
          className="input"
          type="text"
          value={typeof value === "string" ? value : ""}
          placeholder={descriptor.default !== undefined ? String(descriptor.default) : undefined}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        />
      );
    case "number":
    case "int": {
      const hasBothBounds = descriptor.min !== undefined && descriptor.max !== undefined;
      if (hasBothBounds) {
        return (
          <RangeField
            descriptor={descriptor as ParamDescriptor & { min: number; max: number }}
            value={typeof value === "number" ? value : undefined}
            onChange={onChange}
          />
        );
      }
      return (
        <input
          className="input"
          type="number"
          step={descriptor.step ?? (descriptor.type === "int" ? 1 : undefined)}
          min={descriptor.min}
          max={descriptor.max}
          value={typeof value === "number" ? value : ""}
          placeholder={descriptor.default !== undefined ? String(descriptor.default) : undefined}
          onChange={(e) => onChange(clampToDescriptor(descriptor, e.target.value))}
        />
      );
    }
    default:
      return null;
  }
}
