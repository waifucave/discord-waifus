// The Markdown report across models × variants × scenarios (spec §33.3): the automatic metrics per
// group and per run, probe failures with their details, summaries and their must-keep coverage, and
// judged scores once `merge-grades` has run.

import type { GradeSummary, RunSummary } from "./types.js";

export type ResummariseRow = {
  model: string;
  summaryId: string;
  runId: string;
  kind: string;
  outputChars: number;
  inputChars: number;
  facts?: { kept: string[]; missing: string[] };
  usd?: number;
  error?: string;
  grades?: Record<string, number>;
};

export type BenchmarkSummary = {
  generatedAt: string;
  dryRun: boolean;
  selection: { scenarios: string[]; models: string[]; variants: string[]; repeat: number; web: boolean };
  estimate?: { usd: number; minutes: number };
  gate: { minFirstTry: number; minProbes: number };
  runs: RunSummary[];
  resummarise?: ResummariseRow[];
};

const pct = (value: number | null | undefined) => (value === null || value === undefined ? "–" : `${Math.round(value * 100)}%`);
const num = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? "–" : value.toFixed(digits));
const usd = (value: number) => (value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`);
const tokens = (value: number) => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value));
const mean = (values: Array<number | null | undefined>) => {
  const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : null;
};
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function gradeMean(grades: Array<GradeSummary | undefined>, part: "chat" | "summaries"): number | null {
  const values = grades.flatMap((grade) => Object.values(grade?.[part] ?? {}));
  return mean(values);
}

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

/** One row per model × variant over every scenario and repeat. */
function groupRows(runs: readonly RunSummary[]): string[][] {
  const groups = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const key = `${run.model}\u0000${run.variant}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const rows = [...groups.entries()].map(([key, list]) => {
    const [model, variant] = key.split("\u0000") as [string, string];
    const m = list.map((run) => run.metrics);
    const probesPassed = sum(m.map((x) => x.probesPassed));
    const probesScored = sum(m.map((x) => x.probesScored));
    const turns = sum(m.map((x) => x.turns));
    return {
      score: probesScored > 0 ? probesPassed / probesScored : 0,
      row: [
        `\`${model}\``,
        variant,
        String(list.length),
        probesScored > 0 ? `${probesPassed}/${probesScored} (${pct(probesPassed / probesScored)})` : "–",
        String(sum(m.map((x) => x.toolCalls))),
        String(sum(m.map((x) => x.failedCalls))),
        pct(mean(m.map((x) => x.firstTrySuccess))),
        String(sum(m.map((x) => x.retries))),
        String(sum(m.map((x) => x.loops))),
        String(sum(m.map((x) => x.messages))),
        num(mean(m.map((x) => x.medianLineChars))),
        num(Math.max(0, ...m.map((x) => x.longestLineChars ?? 0))),
        num(mean(m.map((x) => x.messagesPerSendingTurn)), 1),
        pct(mean(m.map((x) => x.factCoverage))),
        usd(sum(m.map((x) => x.usd))),
        `${tokens(sum(m.map((x) => x.tokensIn)))} / ${tokens(sum(m.map((x) => x.tokensOut)))}`,
        pct(mean(m.map((x) => x.cacheReadShare))),
        num(turns > 0 ? sum(m.map((x) => (x.secondsPerTurn ?? 0) * x.turns)) / turns : null, 1),
        num(gradeMean(list.map((run) => run.grades), "chat"), 2),
        num(gradeMean(list.map((run) => run.grades), "summaries"), 2)
      ]
    };
  });
  return rows.sort((a, b) => b.score - a.score).map((entry) => entry.row);
}

export function renderReport(summary: BenchmarkSummary): string {
  const runs = summary.runs;
  const out: string[] = [];
  out.push(`# Life benchmark${summary.dryRun ? " (dry run: scripted fake model)" : ""}`);
  out.push("");
  out.push(`Generated ${summary.generatedAt}. Scenarios: ${summary.selection.scenarios.join(", ")}. Variants: ${summary.selection.variants.join(", ")}. Repeat: ${summary.selection.repeat}. Web: ${summary.selection.web ? "on" : "off"}.`);
  const spent = sum(runs.map((run) => run.metrics.usd));
  out.push(`Spent ${usd(spent)}${summary.estimate ? ` (estimated ${usd(summary.estimate.usd)})` : ""} over ${runs.length} run(s). Judge gate: first-try tool success ≥ ${pct(summary.gate.minFirstTry)} and probes ≥ ${pct(summary.gate.minProbes)}.`);
  out.push("");
  out.push("## Models × variants (all scenarios)");
  out.push("");
  out.push(
    table(
      ["model", "variant", "runs", "probes", "tool calls", "failed", "first-try", "retries", "loops", "messages", "median line", "longest line", "msgs/turn", "facts kept", "$", "tokens in/out", "cache read", "s/turn", "chat grade", "summary grade"],
      groupRows(runs)
    )
  );
  out.push("");
  out.push("Probes count passed/scored (n/a probes left out). First-try = share of tool uses whose first call worked; retries = a call to the same tool right after it failed; loops = an identical failing call repeated. Grades are 1–5 means from `merge-grades`.");
  out.push("");
  out.push("## Runs");
  out.push("");
  out.push(
    table(
      ["run", "scenario", "model", "variant", "status", "probes", "turns", "messages", "failed calls", "$", "real s", "gate", "chat", "summaries"],
      runs.map((run) => [
        run.runId,
        run.scenario,
        `\`${run.model}\``,
        run.variant,
        run.status + (run.error ? ` (${run.error.slice(0, 60)})` : ""),
        `${run.metrics.probesPassed}/${run.metrics.probesScored}`,
        String(run.metrics.turns),
        String(run.metrics.messages),
        String(run.metrics.failedCalls),
        usd(run.metrics.usd),
        num(run.realSeconds),
        run.gate ? (run.gate.passed ? "packets" : run.gate.why) : "–",
        num(gradeMean([run.grades], "chat"), 2),
        num(gradeMean([run.grades], "summaries"), 2)
      ])
    )
  );
  out.push("");
  out.push("## Probes");
  out.push("");
  const probeIds = [...new Set(runs.flatMap((run) => run.probes.map((probe) => `${run.scenario}/${probe.id}`)))];
  const models = [...new Set(runs.map((run) => `${run.model} · ${run.variant}`))];
  out.push(
    table(
      ["probe", ...models.map((model) => `\`${model}\``)],
      probeIds.map((id) => {
        const [scenario, probe] = id.split("/") as [string, string];
        return [
          id,
          ...models.map((model) => {
            const results = runs.filter((run) => run.scenario === scenario && `${run.model} · ${run.variant}` === model).map((run) => run.probes.find((entry) => entry.id === probe)?.passed);
            if (results.length === 0) return "";
            return results.map((passed) => (passed === null || passed === undefined ? "n/a" : passed ? "✓" : "✗")).join(" ");
          })
        ];
      })
    )
  );
  out.push("");
  const failures = runs.flatMap((run) => run.probes.filter((probe) => probe.passed === false).map((probe) => `- ${run.runId} · ${probe.id}: ${probe.detail}`));
  if (failures.length > 0) {
    out.push("<details><summary>Why probes failed</summary>");
    out.push("");
    out.push(...failures);
    out.push("");
    out.push("</details>");
    out.push("");
  }
  if (summary.resummarise && summary.resummarise.length > 0) {
    out.push("## Summaries re-scored per model (same saved inputs)");
    out.push("");
    const byModel = new Map<string, ResummariseRow[]>();
    for (const row of summary.resummarise) byModel.set(row.model, [...(byModel.get(row.model) ?? []), row]);
    out.push(
      table(
        ["model", "summaries", "errors", "facts kept", "mean chars (in → out)", "$", "grade"],
        [...byModel.entries()].map(([model, rows]) => {
          const ok = rows.filter((row) => !row.error);
          const kept = sum(ok.map((row) => row.facts?.kept.length ?? 0));
          const due = sum(ok.map((row) => (row.facts?.kept.length ?? 0) + (row.facts?.missing.length ?? 0)));
          return [
            `\`${model}\``,
            String(rows.length),
            String(rows.length - ok.length),
            due > 0 ? `${kept}/${due} (${pct(kept / due)})` : "–",
            `${num(mean(ok.map((row) => row.inputChars)))} → ${num(mean(ok.map((row) => row.outputChars)))}`,
            usd(sum(ok.map((row) => row.usd ?? 0))),
            num(mean(ok.flatMap((row) => Object.values(row.grades ?? {}))), 2)
          ];
        })
      )
    );
    out.push("");
  }
  const flags = runs.flatMap((run) => (run.grades?.flags ?? []).map((flag) => `- ${run.runId}: ${flag}`));
  if (flags.length > 0) {
    out.push("## Grader flags");
    out.push("");
    out.push(...flags);
    out.push("");
  }
  return `${out.join("\n")}\n`;
}
