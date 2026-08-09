import type { ConstraintRule, ParamDescriptor, ResolvedModel } from "@waifucave/gateway";
import {
  ApiError,
  browserSecurityHeaders,
  recoverBrowserSession
} from "./client";

// Re-export so callers only ever touch "@waifucave/gateway" through this module
// (type-only — see docs/superpowers/plans/2026-07-02-gateway-p5-frontend.md Global Constraints:
// value imports of the package are forbidden in frontend code, it touches node:fs).
export type { ConstraintRule, ParamDescriptor, ResolvedModel };

/** Mirrors the gateway's `ModelSummary` (server/handler.ts) — not re-exported by the package's public entry. */
export type LlmModelSummary = {
  providerId: string;
  modelId: string;
  family: string;
  displayName: string;
  company: string;
  wire: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  streaming: boolean;
  tools: boolean;
  reasoning: boolean;
  jsonMode: boolean;
  jsonSchema: boolean;
  imageInput: boolean;
  deprecated: boolean;
  confidence: string;
  routeStatus?: string;
};

export type LlmValidationViolation = { param: string; code: string; ruleId?: string; message?: string };

export type LlmValidationResult = {
  ok: boolean;
  violations: LlmValidationViolation[];
  warnings: Array<{ code: string; param?: string; message?: string }>;
  effectiveParams: Record<string, unknown>;
};

// In dev, Vite proxies /api to backend. In production build served by backend,
// the same origin works. Both cases use "" as base (mirrors ./client.ts).
const BASE = "/api/llm";

type GatewayErrorEnvelope = { error?: { kind?: string; message?: string; retryable?: boolean } };

async function request<T>(method: string, path: string, init?: { body?: unknown }): Promise<T> {
  let headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init?.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res: Response;
    try {
      headers = await browserSecurityHeaders(method, headers);
      res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body,
        credentials: "same-origin"
      });
    } catch (err) {
      throw new ApiError(0, { error: "NetworkError", message: (err as Error).message });
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = { error: "InvalidResponse", message: text.slice(0, 200) };
    }
    if (attempt === 0 && recoverBrowserSession(res.status, parsed)) continue;
    if (!res.ok) {
      // The gateway's error envelope is {error:{kind,message,retryable}} — unwrap it into
      // ApiError's own {error: string, message} shape rather than propagating the object.
      const envelope = (parsed ?? {}) as GatewayErrorEnvelope;
      const message = envelope.error?.message ?? `HTTP ${res.status}`;
      throw new ApiError(res.status, { error: envelope.error?.kind ?? `HTTP ${res.status}`, message }, message);
    }
    return parsed as T;
  }
  throw new ApiError(0, { error: "BrowserSessionError", message: "Browser session recovery failed." });
}

let modelsPromise: Promise<LlmModelSummary[]> | undefined;

/**
 * GET /api/llm/v1/models — module-memoized: the registry doesn't change within a session.
 * On rejection, the memo slot is cleared so a transient fetch failure doesn't permanently
 * poison the cache — the next call retries instead of re-throwing the stale rejection forever.
 */
export async function llmModels(): Promise<LlmModelSummary[]> {
  if (!modelsPromise) {
    const p = request<{ models: LlmModelSummary[] }>("GET", "/v1/models").then((res) => res.models);
    p.catch(() => {
      if (modelsPromise === p) modelsPromise = undefined;
    });
    modelsPromise = p;
  }
  return modelsPromise;
}

const modelCache = new Map<string, Promise<ResolvedModel>>();

/**
 * GET /api/llm/v1/models/:provider/:model — Map-memoized per (providerId, modelId).
 * modelId may itself contain "/" (openrouter route ids like "anthropic/claude-haiku-4.5");
 * the gateway route matches on segment count (>=4) and rejoins everything past the provider
 * segment, so each path segment is encoded individually rather than the whole modelId at once.
 * On rejection, the cache entry is deleted so a transient fetch failure doesn't permanently
 * poison the cache for that key.
 */
export async function llmModel(providerId: string, modelId: string): Promise<ResolvedModel> {
  const cacheKey = `${providerId}::${modelId}`;
  let cached = modelCache.get(cacheKey);
  if (!cached) {
    const segments = [providerId, ...modelId.split("/")].map(encodeURIComponent).join("/");
    const p = request<ResolvedModel>("GET", `/v1/models/${segments}`);
    p.catch(() => {
      if (modelCache.get(cacheKey) === p) modelCache.delete(cacheKey);
    });
    cached = p;
    modelCache.set(cacheKey, cached);
  }
  return cached;
}

/** POST /api/llm/v1/validate — returns 200 even when `ok:false`; not an error path. */
export async function llmValidate(input: {
  provider: string;
  model: string;
  params: Record<string, unknown>;
}): Promise<LlmValidationResult> {
  return request<LlmValidationResult>("POST", "/v1/validate", { body: input });
}

/** GET /api/llm/v1/providers */
export async function llmProviders(): Promise<
  Array<{ id: string; displayName: string; baseUrl: string; credentialConfigured: boolean; wire: string }>
> {
  const res = await request<{
    providers: Array<{ id: string; displayName: string; baseUrl: string; credentialConfigured: boolean; wire: string }>;
  }>("GET", "/v1/providers");
  return res.providers;
}
