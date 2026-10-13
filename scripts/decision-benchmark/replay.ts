import { RUBRICS, type BenchmarkCase, type DecisionRubrics, type QuestionName } from "./cases.js";

export type ReplayLabel = { id: string; allowedPause: string[]; allowFreshTopic: boolean };
// Labels are supplied independently. Historical referenceResponse is never read.
export function replayCases(capture: { samples: { id: string; request: any }[] }, labels: ReplayLabel[]): BenchmarkCase[] {
  return labels.map((label) => {
    const sample = capture.samples.find((s) => s.id === label.id);
    if (!sample) throw new Error("replay_sample_missing");
    const cast: string[][] = [];
    const walk = (v: any) => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v.properties?.waifuId?.enum)) cast.push(v.properties.waifuId.enum);
      for (const child of Object.values(v)) walk(child);
    };
    walk(sample.request.tools);
    const ids = [...new Set(cast.flat())];
    if (!ids.length || ids.length > 7 || !ids.every((id) => typeof id === "string" && id && !id.includes("|"))) throw new Error("replay_cast_unsupported");
    const text = (parts: any[]) => (parts ?? []).filter((p) => typeof p?.text === "string").map((p) => p.text);
    // Keep conversation evidence and instructions, dropping all historical model
    // decisions/function responses to avoid anchoring challengers on Beta's choices.
    const evidence: string[] = sample.request.contents.filter((c: any) => c.role === "user").flatMap((c: any) => text(c.parts));
    const state = [ ...text(sample.request.systemInstruction?.parts), ...evidence ].join("\n\n");
    const criteria: Record<string, string> = { nobody: "Nobody speaks now." };
    for (let mask = 1; mask < 2 ** ids.length; mask++) {
      const subset = ids.filter((_, i) => mask & (1 << i)).sort();
      criteria[subset.join("|")] = `Only these characters speak: ${subset.join(", ")}.`;
    }
    const rubrics: DecisionRubrics = {
      next: { instructions: "Choose who speaks next according to the supplied room policy, cast cards, transcript and wake state. Previous model choices are not authority. Nobody is valid when the beat is spent. Multiple speakers need distinct reasons.", criteria },
      pause: { instructions: "Choose a planned re-check bucket. now means reply now. short means 100 seconds; farewell means a longer 600-second pause; dead means 3600 seconds. Timer wakes must execute a genuine pivot or extend the prior pause, never repeat the same short pause.",
        criteria: { now: "Reply now without a pause.", short: "Re-check in 100 seconds.", farewell: "Re-check in 600 seconds: cooling down or extending a previous short pause.", dead: "Re-check in 3600 seconds: a long quiet-room backoff." } },
      steering: { ...RUBRICS.steering, instructions: "Choose whether the next message needs steering under the room policy. A spent repetitive beat cannot receive another plain restatement. A genuine new topic requires change_topic; breaking a strong loop may use break_loop. Silence requires none. This predicts intent only, not a written goal." }
    };
    const awake = ids.filter((id) => {
      const card = state.slice(state.lastIndexOf(`ID: ${id} ·`)).split(/<\//)[0];
      return !card.includes("Now: likely asleep");
    });
    if (!label.allowedPause.length || !label.allowedPause.every((p) => p !== "now" && Object.hasOwn(rubrics.pause.criteria, p))) throw new Error("invalid_replay_labels");
    const tuples: Record<QuestionName, string>[] = label.allowedPause.map((pause) => ({ next: "nobody", pause, steering: "none" }));
    if (label.allowFreshTopic) for (const id of awake) for (const steering of ["change_topic", "break_loop"]) tuples.push({ next: id, pause: "now", steering });
    return { id: sample.id, group: "real-spent-beat-policy", state, rubrics, acceptableTuples: tuples,
      expected: Object.fromEntries((["next", "pause", "steering"] as const).map((q) => [q, [...new Set(tuples.map((t) => t[q]))]])) as BenchmarkCase["expected"] };
  });
}
