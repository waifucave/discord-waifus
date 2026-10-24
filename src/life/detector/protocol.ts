export type ChoiceQuestion = { instructions: string; criteria: Record<string, string> };
export type ChoiceQuestions = Record<string, ChoiceQuestion>;
export type ChoiceAnswers = Record<string, { choice: string; probabilities: Record<string, number> }>;

export async function readDecisionJson(response: Response, maxBytes = 1_000_000): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("one_shot_invalid_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("one_shot_response_too_large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new Error("one_shot_invalid_response"); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export function decisionRequest(model: string, state: string, questions: ChoiceQuestions, openai: boolean): object {
  return openai ? { model, input: state, questions: Object.entries(questions).map(([name, q]) => ({
    name, type: "choice", instructions: q.instructions,
    choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description }))
  })) } : { model, state, questions: Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, { type: "choice", ...q }])) };
}

export function decisionAnswers(payload: unknown, questions: ChoiceQuestions, openai: boolean): ChoiceAnswers {
  if (!payload || typeof payload !== "object") throw new Error("one_shot_invalid_response");
  const source = (payload as { answers?: unknown }).answers;
  const out: ChoiceAnswers = {};
  for (const [name, q] of Object.entries(questions)) {
    let raw: unknown;
    if (openai) {
      if (!Array.isArray(source) || source.filter((v) => v?.name === name).length !== 1) throw new Error("one_shot_invalid_answer");
      raw = source.find((v) => v?.name === name);
    } else if (source && typeof source === "object") raw = (source as Record<string, unknown>)[name];
    if (!raw || typeof raw !== "object") throw new Error("one_shot_invalid_answer");
    const a = raw as { type?: unknown; choice?: unknown; probabilities?: unknown };
    if (a.type !== "choice" || typeof a.choice !== "string" || !Object.hasOwn(q.criteria, a.choice)) throw new Error("one_shot_invalid_choice");
    let p: unknown = a.probabilities;
    if (openai) {
      if (!Array.isArray(p) || p.some((v) => !v || typeof v.value !== "string") || new Set(p.map((v) => v.value)).size !== p.length) throw new Error("one_shot_invalid_probabilities");
      p = Object.fromEntries(p.map((v) => [v.value, v.probability]));
    }
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("one_shot_invalid_probabilities");
    const probabilities = p as Record<string, number>;
    const allowed = Object.keys(q.criteria);
    if (Object.keys(probabilities).length !== allowed.length || !allowed.every((v) => Object.hasOwn(probabilities, v)
      && typeof probabilities[v] === "number" && Number.isFinite(probabilities[v]) && probabilities[v] >= 0 && probabilities[v] <= 1)
      || Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) > 0.015
      || probabilities[a.choice] + 1e-5 < Math.max(...Object.values(probabilities))) throw new Error("one_shot_invalid_probabilities");
    out[name] = { choice: a.choice, probabilities };
  }
  return out;
}
