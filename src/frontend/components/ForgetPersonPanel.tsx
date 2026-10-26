import { useId, useRef, useState } from "react";
import { api } from "../api/client";
import type { ForgetUserResult } from "../api/types";
import { FORGET_LIMITS } from "../../shared/constants/forget";
import { ConfirmDialog } from "./ConfirmDialog";
import { Notice } from "./Notice";

const SNOWFLAKE = /^\d{17,20}$/u;

/** What a forget did (or would do), in words. */
export function forgetSummary(result: ForgetUserResult): string[] {
  const verb = result.dryRun ? "Would remove" : "Removed";
  const lines = [
    `${verb} ${result.dmStates} DM state file(s), ${result.dmContexts} DM conversation(s), ${result.dmLimits} rate-limit file(s) and ${result.cachedImages} cached image(s)` +
      (result.memberLists !== undefined ? `, and ${result.memberLists} member-list entr${result.memberLists === 1 ? "y" : "ies"}` : "") +
      "."
  ];
  if (result.archive) lines.push(`Archive: ${result.archive.removed} of ${result.archive.files} file(s) scrubbed${result.archive.unreadable ? `, ${result.archive.unreadable} unreadable` : ""}.`);
  for (const life of result.lives ?? []) {
    lines.push(
      life.queued
        ? `${life.waifuId}: scrub queued.`
        : `${life.waifuId}: ${life.removedLines} log line(s) and ${life.removedSentences} sentence(s) removed${life.removedNotes !== undefined ? `, ${life.removedNotes} note(s)` : ""}${life.removedFiles ? `, ${life.removedFiles} file(s)` : ""}${life.needsReview.length ? `; ${life.needsReview.length} line(s) to review` : ""}.`
    );
  }
  if (result.livesQueued?.length) lines.push(`Life scrubs queued until each life next starts: ${result.livesQueued.join(", ")}.`);
  for (const pending of result.pending ?? []) {
    lines.push(`Not finished: ${pending.part}${pending.error ? ` (${pending.error})` : ""}; ${pending.retried ? "it runs again at the next start." : "given up after three tries."}`);
  }
  return lines;
}

/**
 * The owner's forget of one Discord user (Living cast §7.5), with the scrub's limits stated first.
 * `onForgotten` lets the page refresh what the forget changed (its review lines, her status).
 */
export function ForgetPersonPanel({ onForgotten }: { onForgotten?: () => void } = {}) {
  const inputId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const [userId, setUserId] = useState("");
  const [preview, setPreview] = useState<ForgetUserResult | undefined>(undefined);
  const [result, setResult] = useState<ForgetUserResult | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const valid = SNOWFLAKE.test(userId.trim());

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const answer = await api.forgetUser(userId.trim(), dryRun);
      if (dryRun) {
        setPreview(answer);
        setConfirming(true);
      } else {
        setResult(answer);
        setConfirming(false);
        setPreview(undefined);
        onForgotten?.();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cell cell-pad">
      <div className="t-title" style={{ marginBottom: 6 }}>Forget a person</div>
      <p className="t-small" style={{ lineHeight: 1.5, margin: "0 0 8px" }}>
        Removes a Discord user from every DM, the member lists and the archive, and scrubs every waifu&apos;s life,
        summary, queue and files. Forget is a best-effort scrub:
      </p>
      <ul className="t-small t-mute" style={{ lineHeight: 1.5, margin: "0 0 12px", paddingLeft: 18 }}>
        {FORGET_LIMITS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <label className="field-label" htmlFor={inputId}>
        Discord user id
      </label>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
        <input
          id={inputId}
          className="input"
          style={{ maxWidth: 280 }}
          placeholder="Discord user id (17–20 digits)"
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setResult(undefined);
          }}
        />
        <button ref={opener} className="btn danger" disabled={!valid || busy} onClick={() => void run(true)}>
          {busy && !confirming ? "Checking…" : "Forget…"}
        </button>
      </div>
      {error && (
        <div style={{ marginTop: 12 }}>
          <Notice tone="err">{error}</Notice>
        </div>
      )}
      {result && (
        <div style={{ marginTop: 12 }}>
          <Notice tone={result.pending?.length ? "warn" : "ok"} title={`Forgot ${result.discordUserId}`}>
            {forgetSummary(result).map((line) => (
              <div key={line}>{line}</div>
            ))}
          </Notice>
        </div>
      )}
      {confirming && preview && (
        <ConfirmDialog
          title={`Forget ${preview.discordUserId} everywhere?`}
          cancelLabel="Keep"
          confirmLabel={busy ? "Forgetting…" : "Forget"}
          busy={busy}
          width={560}
          returnFocus={() => opener.current}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void run(false)}
        >
          {forgetSummary(preview).map((line) => (
            <p className="t-small" key={line} style={{ margin: "0 0 6px" }}>
              {line}
            </p>
          ))}
          <p className="t-small t-mute" style={{ marginTop: 10 }}>
            Then every waifu&apos;s life and files are scrubbed. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
