import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../../src/backend/redaction.js";
import { atomicWriteJson } from "../../src/storage/atomic.js";

// Only this read-only function runs on the host. Full snapshot output is captured
// privately by the parent; no API mutations, messages, keys, or host files are changed.
async function captureRemote() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.join(process.env.HOME!, ".dc-waifus");
  const runtime = JSON.parse(await fs.readFile(path.join(root, "app/runtime.json"), "utf8"));
  const config = JSON.parse(await fs.readFile(path.join(root, "user/orchestrator/config.json"), "utf8"));
  // Decision history is per guild since Phase 5 (spec 9.3): count every guild file plus the
  // no-guild legacy file; hosts that have not migrated yet still have the global file.
  const countDecisions = async (file: string): Promise<number> => {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      return Array.isArray(parsed.decisions) ? parsed.decisions.length : 0;
    } catch { return 0; }
  };
  let storedDecisionCount = await countDecisions(path.join(root, "user/orchestrator/history.json"))
    + await countDecisions(path.join(root, "user/orchestrator/history-legacy.json"));
  for (const entry of await fs.readdir(path.join(root, "user/servers")).catch(() => [] as string[])) {
    storedDecisionCount += await countDecisions(path.join(root, "user/servers", entry, "orchestrator-history.json"));
  }
  const ac = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/events`, {
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(15000)]), redirect: "error"
    });
    if (!response.ok || !response.body) throw new Error("snapshot_unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (buffer.length < 16_000_000) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // The final fragment may be incomplete JSON; never try to parse it.
      const frame = buffer.split("\n\n").slice(0, -1).find((f) => /^event: snapshot$/m.test(f));
      if (!frame) continue;
      const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      const snapshot = JSON.parse(data);
      const queries = snapshot.queries.filter((q: any) => q.role === "orchestrator");
      const paired = queries.flatMap((query: any) => {
        const reply = snapshot.replies.find((r: any) => r.queryId === query.id && r.role === "orchestrator" && r.ok);
        return reply ? [{ capturedAt: query.time, request: query.payload, referenceResponse: reply.payload }] : [];
      });
      return { capturedAt: new Date().toISOString(), appVersion: runtime.packageVersion,
        baseline: { providerId: config.providerId, modelId: config.modelId },
        storedDecisionCount, samples: paired };
    }
    throw new Error("snapshot_incomplete");
  } finally { ac.abort(); }
}

export function stripCaptureMedia(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCaptureMedia);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["inlineData", "fileData", "image_url", "imageUrl", "attachments"].includes(key))
    .map(([key, v]) => [key, stripCaptureMedia(v)]));
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => args.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
  const host = arg("ssh-host");
  const key = arg("ssh-key");
  if (!host || host.startsWith("-") || !/^[A-Za-z0-9_.@:-]+$/.test(host) || !key) throw new Error("ssh_options_required");
  const destination = path.resolve(arg("output") ?? "tests/eval/fixtures/live/orchestrator-capture.json");
  // Prevent accidentally creating a tracked fixture containing private conversations.
  const privateRoot = path.resolve("tests/eval/fixtures/live");
  if (!destination.startsWith(privateRoot + path.sep) || path.extname(destination) !== ".json") throw new Error("private_fixture_destination_required");
  const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "IdentitiesOnly=yes", "-i", path.resolve(key), host,
    "PATH=/opt/homebrew/bin:/usr/bin:/bin node --input-type=module"], { stdio: ["pipe", "pipe", "pipe"] });
  let raw = "";
  let tooLarge = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (raw.length + chunk.length > 16_000_000) { tooLarge = true; child.kill(); }
    else raw += chunk;
  });
  // Drain stderr without relaying remote exception text or snapshot contents.
  child.stderr.resume();
  const exit = new Promise<void>((resolve, reject) => {
    child.on("error", () => reject(new Error("ssh_failed")));
    child.on("exit", (code) => code === 0 && !tooLarge ? resolve() : reject(new Error("capture_failed")));
  });
  child.stdin.end(`(${captureRemote.toString()})().then(v=>process.stdout.write(JSON.stringify(v))).catch(()=>{process.stderr.write("capture_failed");process.exitCode=1;});`);
  await exit;
  const captured = redactSecrets(stripCaptureMedia(JSON.parse(raw))) as { baseline: unknown; storedDecisionCount: number; samples: unknown[] };
  const samples = captured.samples.map((sample, i) => ({ id: `live-${i + 1}`, ...sample as object }));
  await atomicWriteJson(destination, { version: 1, source: "read-only-host-snapshot", referenceKind: "historical_model_answer_not_ground_truth", ...captured, samples });
  console.log(JSON.stringify({ saved: true, samples: samples.length, storedDecisionCount: captured.storedDecisionCount,
    baseline: captured.baseline, privateFixture: path.relative(process.cwd(), destination), mediaExcluded: true }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Read-only capture failed; no private response or exception text was printed."); process.exitCode = 1; });
}
