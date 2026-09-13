# Gateway P1a: Registry + Validation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the `@waifucave/gateway` repo and build its data-driven core: the capability registry (54 researched docs, route-overlay resolution) and the validation/constraint engine that rejects or adjusts requests per model quirks.

**Architecture:** Capability docs are JSON data shipped with the package (`data/*.json`, one file per company, produced by P0 research). A loader indexes them by `(providerId, modelId)` and resolves per-route overlays (base URLs, context limits, OpenRouter `supportedParameters` filtering). A pure constraint engine evaluates declarative `when/then` rules (`forbid`/`drop`/`force`/`clamp`), and a request validator combines descriptor checks (type/range/enum/maxItems) with the constraint engine. No runtime dependencies; zod is dev-only (schema test that gates the data files). P1b (codecs/transport/client) and P1c (HTTP server/drift sync) build on this and get their own plans.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), Node ≥ 20, Vitest, zod (devDependency only).

**Repo location:** `/Users/example/Xcode projects/waifucave-gateway` (sibling of `Discord Waifus`; pushed later to `waifucave/gateway`). All commands below run from that directory unless stated otherwise.

**Context docs:** `Discord Waifus/MIGRATION_PLAN.md` (§4 gateway design, Table B providers), `Discord Waifus/research/p0-capability-docs/` (the 15 data files + findings.md).

---

## File structure

```
waifucave-gateway/
├── package.json                 # @waifucave/gateway, ESM, zero runtime deps
├── tsconfig.json                # NodeNext, strict, src → dist
├── vitest.config.ts
├── .gitignore
├── data/                        # capability docs, copied verbatim from P0 research
│   └── {anthropic,arcee-ai,deepseek,google,minimax,mistral,moonshot-ai,
│        nvidia,openai,openrouter,qwen,stepfun,xai,xiaomi,z-ai}.json
├── docs/research-findings.md    # provenance: findings.md from P0
├── src/
│   ├── index.ts                 # public exports
│   ├── registry/
│   │   ├── types.ts             # CapabilityDoc, ParamDescriptor, ConstraintRule, ResolvedModel
│   │   ├── schema.ts            # zod schema mirroring types.ts (dev/test only)
│   │   ├── providers.ts         # static table of the 14 v1 providers
│   │   └── loader.ts            # Registry: load, index, resolve route overlays
│   └── validate/
│       ├── constraints.ts       # when/then rule engine (pure functions)
│       └── validateRequest.ts   # descriptor checks + constraint engine
└── tests/
    ├── registry/schema.test.ts      # every data file validates; ids unique
    ├── registry/providers.test.ts   # table integrity; data↔table cross-check
    ├── registry/loader.test.ts      # counts, overlay resolution, param filtering
    ├── validate/constraints.test.ts # each rule action; live-validated DeepSeek case
    └── validate/validateRequest.test.ts
```

Responsibilities: `types.ts` is the single type authority (schema.ts mirrors it; a unit test keeps them honest). `loader.ts` owns all overlay/merging logic — codecs in P1b consume only `ResolvedModel` and never read raw docs. `constraints.ts` is pure and knows nothing about HTTP or models; `validateRequest.ts` is the only composition point.

**Data-shape facts** (audited 2026-06-10 across all 54 docs — the code below is written against these):
- Route override keys in the wild: `baseUrl`, `endpoint`, `contextTokens`, `maxOutputTokens`, `pricing`, `modalities`, `supportedParameters`, `status`, `source`, `note`, `mode`, `aliases`, `alternateChinaBaseUrl` (stepfun), `anthropicEndpoint` (xiaomi).
- Param descriptor types: `number`, `int`, `boolean`, `enum`, `string`, `string[]`, `map`; param-level confidence: `verified` | `unverified`.
- Constraint `when` keys used: `param`+`eq`/`neq`/`gt` (engine also implements `lt`, `in`, `allOf`, `anyOf` per MIGRATION_PLAN §4.2). `then` keys used: `forbid`, `drop`, `force` (engine also implements `clamp`).
- `forbid` grammar: bare param name (`"presencePenalty"`) or value-qualified (`"toolChoice:required"`, `"responseFormat:json_object"`).
- Doc-level confidence: `verified` | `partial` | `unverified` | `conflicting`.

---

### Task 1: Scaffold the repo

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`

- [ ] **Step 1: Create directory and git init**

```bash
mkdir -p "/Users/example/Xcode projects/waifucave-gateway"
cd "/Users/example/Xcode projects/waifucave-gateway"
git init -b main
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "@waifucave/gateway",
  "version": "0.0.0",
  "description": "Provider-agnostic LLM normalization layer: capability registry, parameter validation, unified chat API",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "data"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "zod": "^3.24.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 6: Install and verify**

```bash
npm install
npx tsc --version
```
Expected: installs cleanly; TypeScript ≥ 5.6 reported.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore package-lock.json
git commit -m "chore: scaffold @waifucave/gateway package"
```

---

### Task 2: Import the P0 capability data

**Files:**
- Create: `data/*.json` (15 files), `docs/research-findings.md`

- [ ] **Step 1: Copy data verbatim from the Discord Waifus repo**

```bash
cd "/Users/example/Xcode projects/waifucave-gateway"
mkdir -p data docs
cp "/Users/example/Xcode projects/Discord Waifus/research/p0-capability-docs/"*.json data/
cp "/Users/example/Xcode projects/Discord Waifus/research/p0-capability-docs/findings.md" docs/research-findings.md
```

- [ ] **Step 2: Sanity-check the copy**

```bash
ls data | wc -l && node -e '
const fs=require("fs");let n=0;
for (const f of fs.readdirSync("data")) n += JSON.parse(fs.readFileSync("data/"+f,"utf8")).length;
console.log(n+" docs");'
```
Expected: `15` files, `54 docs`.

- [ ] **Step 3: Commit**

```bash
git add data docs
git commit -m "feat: import P0 capability docs (54 models, 15 companies)"
```

---

### Task 3: Registry types

**Files:**
- Create: `src/registry/types.ts`

- [ ] **Step 1: Write `src/registry/types.ts`**

```ts
export type WireProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-language";

export type ParamType = "number" | "int" | "boolean" | "enum" | "string" | "string[]" | "map";

export type Confidence = "verified" | "partial" | "unverified" | "conflicting";

export type ParamDescriptor = {
  type: ParamType;
  min?: number;
  max?: number;
  step?: number;
  values?: string[];
  maxItems?: number;
  default?: unknown;
  wireName?: string;
  confidence?: Extract<Confidence, "verified" | "unverified">;
};

export type ConstraintCondition = {
  param?: string;
  eq?: unknown;
  neq?: unknown;
  gt?: number;
  lt?: number;
  in?: unknown[];
  allOf?: ConstraintCondition[];
  anyOf?: ConstraintCondition[];
};

export type ConstraintAction = {
  forbid?: string[]; // "paramName" or "paramName:value"
  drop?: string[];
  force?: Record<string, unknown>;
  clamp?: Record<string, { min?: number; max?: number }>;
};

export type ConstraintRule = {
  id: string;
  when: ConstraintCondition;
  then: ConstraintAction;
  source?: string;
};

export type Pricing = {
  inputPerMTok?: number | null;
  outputPerMTok?: number | null;
  cachedInputPerMTok?: number | null;
};

export type RouteOverrides = {
  baseUrl?: string;
  endpoint?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  pricing?: Pricing;
  modalities?: string[];
  supportedParameters?: string[];
  status?: string;
  source?: string;
  note?: string;
  mode?: string;
  aliases?: string[];
  alternateChinaBaseUrl?: string;
  anthropicEndpoint?: string;
};

export type RouteDef = {
  providerId: string;
  modelId: string;
  wire: WireProtocol;
  overrides?: RouteOverrides;
};

export type ToolFeatures = {
  supported: boolean;
  toolChoice?: Array<"auto" | "none" | "required" | "named">;
  parallel?: boolean;
  parallelDisable?: boolean;
  strict?: boolean;
};

export type Features = {
  streaming: boolean;
  streamingUsage?: boolean;
  tools: ToolFeatures;
  structuredOutput: { jsonMode?: boolean; jsonSchema?: boolean; strict?: boolean };
  promptCaching: { kind: "none" | "implicit" | "explicit" };
  assistantPrefill?: boolean;
  systemRole: "system" | "developer" | "top-level" | "systemInstruction";
  multipleSystemMessages?: boolean;
  reasoningRoundTrip?: boolean;
};

export type CapabilityDoc = {
  schema: "starlight.capability-doc.v1";
  family: string;
  displayName: string;
  company: string;
  routes: RouteDef[];
  limits: { contextTokens: number; maxOutputTokens: number };
  modalities: { input: string[]; output: string[] };
  features: Features;
  params: Record<string, ParamDescriptor>;
  constraints?: ConstraintRule[];
  meta: {
    pricing?: Pricing;
    knowledgeCutoff?: string;
    deprecated?: boolean;
    sources: string[];
    verifiedAt?: string;
    confidence: Confidence;
  };
};

export type ProviderDef = {
  id: string;
  displayName: string;
  baseUrl: string;
  credentialEnv: string;
  wire: WireProtocol;
};

/** A (providerId, modelId) route with all overlays applied. What codecs consume. */
export type ResolvedModel = {
  providerId: string;
  modelId: string;
  wire: WireProtocol;
  family: string;
  displayName: string;
  company: string;
  baseUrl: string;
  endpoint: string;
  limits: { contextTokens: number; maxOutputTokens: number };
  modalities: { input: string[]; output: string[] };
  features: Features;
  params: Record<string, ParamDescriptor>;
  constraints: ConstraintRule[];
  meta: CapabilityDoc["meta"] & { routeStatus?: string; routeNote?: string };
};

export type RegistryDiagnostic = {
  level: "warning";
  family: string;
  providerId: string;
  message: string;
};
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: clean exit.

- [ ] **Step 3: Commit**

```bash
git add src/registry/types.ts
git commit -m "feat: add capability-doc and resolved-model types"
```

---

### Task 4: Zod schema + data validation test

The schema test is the package's CI gate for the data files.

**Files:**
- Create: `src/registry/schema.ts`
- Test: `tests/registry/schema.test.ts`

- [ ] **Step 1: Write the failing test `tests/registry/schema.test.ts`**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapabilityDocSchema } from "../../src/registry/schema.js";

const dataDir = join(import.meta.dirname, "../../data");
const files = readdirSync(dataDir).filter((f) => f.endsWith(".json"));

describe("capability data files", () => {
  it("has 15 company files", () => {
    expect(files).toHaveLength(15);
  });

  it("every doc validates against the schema", () => {
    for (const file of files) {
      const docs = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
      expect(Array.isArray(docs), `${file} must be an array`).toBe(true);
      for (const doc of docs) {
        const result = CapabilityDocSchema.safeParse(doc);
        expect(
          result.success,
          `${file}/${doc.family}: ${result.success ? "" : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        ).toBe(true);
      }
    }
  });

  it("has 54 docs with unique families and unique (provider, model) routes", () => {
    const families = new Set<string>();
    const routes = new Set<string>();
    let count = 0;
    for (const file of files) {
      for (const doc of JSON.parse(readFileSync(join(dataDir, file), "utf8"))) {
        count++;
        expect(families.has(doc.family), `duplicate family ${doc.family}`).toBe(false);
        families.add(doc.family);
        for (const route of doc.routes) {
          const key = `${route.providerId}:${route.modelId}`;
          expect(routes.has(key), `duplicate route ${key}`).toBe(false);
          routes.add(key);
        }
      }
    }
    expect(count).toBe(54);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/registry/schema.test.ts
```
Expected: FAIL — cannot resolve `../../src/registry/schema.js`.

- [ ] **Step 3: Write `src/registry/schema.ts`**

```ts
import { z } from "zod";

const ParamDescriptorSchema = z
  .object({
    type: z.enum(["number", "int", "boolean", "enum", "string", "string[]", "map"]),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    values: z.array(z.string()).optional(),
    maxItems: z.number().int().optional(),
    default: z.unknown().optional(),
    wireName: z.string().optional(),
    confidence: z.enum(["verified", "unverified"]).optional()
  })
  .strict();

const ConstraintConditionSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      param: z.string().optional(),
      eq: z.unknown().optional(),
      neq: z.unknown().optional(),
      gt: z.number().optional(),
      lt: z.number().optional(),
      in: z.array(z.unknown()).optional(),
      allOf: z.array(ConstraintConditionSchema).optional(),
      anyOf: z.array(ConstraintConditionSchema).optional()
    })
    .strict()
);

const ConstraintRuleSchema = z
  .object({
    id: z.string().min(1),
    when: ConstraintConditionSchema,
    then: z
      .object({
        forbid: z.array(z.string()).optional(),
        drop: z.array(z.string()).optional(),
        force: z.record(z.string(), z.unknown()).optional(),
        clamp: z.record(z.string(), z.object({ min: z.number().optional(), max: z.number().optional() }).strict()).optional()
      })
      .strict(),
    source: z.string().optional()
  })
  .strict();

const PricingSchema = z
  .object({
    inputPerMTok: z.number().nullable().optional(),
    outputPerMTok: z.number().nullable().optional(),
    cachedInputPerMTok: z.number().nullable().optional()
  })
  .strict();

const RouteOverridesSchema = z
  .object({
    baseUrl: z.string().url().optional(),
    endpoint: z.string().optional(),
    contextTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().nullable().optional(),
    pricing: PricingSchema.optional(),
    modalities: z.array(z.string()).optional(),
    supportedParameters: z.array(z.string()).optional(),
    status: z.string().optional(),
    source: z.string().optional(),
    note: z.string().optional(),
    mode: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    alternateChinaBaseUrl: z.string().url().optional(),
    anthropicEndpoint: z.string().url().optional()
  })
  .strict();

export const CapabilityDocSchema = z
  .object({
    schema: z.literal("starlight.capability-doc.v1"),
    family: z.string().min(1),
    displayName: z.string().min(1),
    company: z.string().min(1),
    routes: z
      .array(
        z
          .object({
            providerId: z.string().min(1),
            modelId: z.string().min(1),
            wire: z.enum(["openai-chat", "openai-responses", "anthropic-messages", "google-generative-language"]),
            overrides: RouteOverridesSchema.optional()
          })
          .strict()
      )
      .min(1),
    limits: z.object({ contextTokens: z.number().int(), maxOutputTokens: z.number().int() }).strict(),
    modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }).strict(),
    features: z
      .object({
        streaming: z.boolean(),
        streamingUsage: z.boolean().optional(),
        tools: z
          .object({
            supported: z.boolean(),
            toolChoice: z.array(z.enum(["auto", "none", "required", "named"])).optional(),
            parallel: z.boolean().optional(),
            parallelDisable: z.boolean().optional(),
            strict: z.boolean().optional()
          })
          .strict(),
        structuredOutput: z
          .object({ jsonMode: z.boolean().optional(), jsonSchema: z.boolean().optional(), strict: z.boolean().optional() })
          .strict(),
        promptCaching: z.object({ kind: z.enum(["none", "implicit", "explicit"]) }).strict(),
        assistantPrefill: z.boolean().optional(),
        systemRole: z.enum(["system", "developer", "top-level", "systemInstruction"]),
        multipleSystemMessages: z.boolean().optional(),
        reasoningRoundTrip: z.boolean().optional()
      })
      .strict(),
    params: z.record(z.string(), ParamDescriptorSchema),
    constraints: z.array(ConstraintRuleSchema).optional(),
    meta: z
      .object({
        pricing: PricingSchema.optional(),
        knowledgeCutoff: z.string().optional(),
        deprecated: z.boolean().optional(),
        sources: z.array(z.string()).min(1),
        verifiedAt: z.string().optional(),
        confidence: z.enum(["verified", "partial", "unverified", "conflicting"])
      })
      .strict()
  })
  .strict();

export type CapabilityDocParsed = z.infer<typeof CapabilityDocSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/registry/schema.test.ts
```
Expected: PASS (3 tests). If a data file fails `.strict()` validation, the assertion message names the file, family, and offending path — fix the schema if the data shape is legitimate (the audited shapes above are authoritative), or fix the data if Codex emitted junk. Do not loosen `.strict()`.

- [ ] **Step 5: Commit**

```bash
git add src/registry/schema.ts tests/registry/schema.test.ts
git commit -m "feat: add zod schema gating the capability data files"
```

---

### Task 5: Provider table

**Files:**
- Create: `src/registry/providers.ts`
- Test: `tests/registry/providers.test.ts`

- [ ] **Step 1: Write the failing test `tests/registry/providers.test.ts`**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDERS, getProvider } from "../../src/registry/providers.js";

describe("provider table", () => {
  it("contains the 14 v1 providers with unique ids", () => {
    expect(PROVIDERS).toHaveLength(14);
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(14);
    expect(getProvider("openrouter")?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(getProvider("xiaomi")?.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(getProvider("nope")).toBeUndefined();
  });

  it("every route providerId in the data exists in the table", () => {
    const dataDir = join(import.meta.dirname, "../../data");
    for (const file of readdirSync(dataDir).filter((f) => f.endsWith(".json"))) {
      for (const doc of JSON.parse(readFileSync(join(dataDir, file), "utf8"))) {
        for (const route of doc.routes) {
          expect(getProvider(route.providerId), `${file}/${doc.family}: unknown provider ${route.providerId}`).toBeDefined();
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/registry/providers.test.ts
```
Expected: FAIL — cannot resolve `providers.js`.

- [ ] **Step 3: Write `src/registry/providers.ts`** (values from MIGRATION_PLAN.md Table B)

```ts
import { ProviderDef } from "./types.js";

export const PROVIDERS: ProviderDef[] = [
  { id: "openrouter", displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", credentialEnv: "OPENROUTER_API_KEY", wire: "openai-chat" },
  { id: "anthropic", displayName: "Anthropic", baseUrl: "https://api.anthropic.com", credentialEnv: "ANTHROPIC_API_KEY", wire: "anthropic-messages" },
  { id: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", credentialEnv: "OPENAI_API_KEY", wire: "openai-responses" },
  { id: "google-ai-studio", displayName: "Google AI Studio", baseUrl: "https://generativelanguage.googleapis.com", credentialEnv: "GOOGLE_AI_STUDIO_API_KEY", wire: "google-generative-language" },
  { id: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", credentialEnv: "DEEPSEEK_API_KEY", wire: "openai-chat" },
  { id: "xai", displayName: "xAI", baseUrl: "https://api.x.ai/v1", credentialEnv: "XAI_API_KEY", wire: "openai-chat" },
  { id: "zai", displayName: "Z.AI", baseUrl: "https://api.z.ai/api/paas/v4", credentialEnv: "ZAI_API_KEY", wire: "openai-chat" },
  { id: "moonshot", displayName: "Moonshot AI", baseUrl: "https://api.moonshot.ai/v1", credentialEnv: "MOONSHOT_API_KEY", wire: "openai-chat" },
  { id: "qwen", displayName: "Qwen (DashScope Intl)", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", credentialEnv: "DASHSCOPE_API_KEY", wire: "openai-chat" },
  { id: "minimax", displayName: "MiniMax", baseUrl: "https://api.minimax.io/v1", credentialEnv: "MINIMAX_API_KEY", wire: "openai-chat" },
  { id: "mistral", displayName: "Mistral", baseUrl: "https://api.mistral.ai/v1", credentialEnv: "MISTRAL_API_KEY", wire: "openai-chat" },
  { id: "nvidia", displayName: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", credentialEnv: "NVIDIA_API_KEY", wire: "openai-chat" },
  { id: "stepfun", displayName: "StepFun", baseUrl: "https://api.stepfun.ai/v1", credentialEnv: "STEPFUN_API_KEY", wire: "openai-chat" },
  { id: "xiaomi", displayName: "Xiaomi MiMo", baseUrl: "https://api.xiaomimimo.com/v1", credentialEnv: "XIAOMI_API_KEY", wire: "openai-chat" }
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): ProviderDef | undefined {
  return byId.get(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/registry/providers.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/providers.ts tests/registry/providers.test.ts
git commit -m "feat: add v1 provider table (14 providers)"
```

---

### Task 6: Registry loader with route-overlay resolution

**Files:**
- Create: `src/registry/loader.ts`
- Test: `tests/registry/loader.test.ts`

- [ ] **Step 1: Write the failing test `tests/registry/loader.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";

const registry = Registry.load();

describe("Registry", () => {
  it("loads 54 families and flattens all routes", () => {
    expect(registry.listFamilies()).toHaveLength(54);
    expect(registry.listModels().length).toBeGreaterThan(54);
  });

  it("resolves a native route with provider-table base URL fallback", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro");
    expect(model).toBeDefined();
    expect(model!.baseUrl).toBe("https://api.deepseek.com");
    expect(model!.endpoint).toBe("/chat/completions");
    expect(model!.wire).toBe("openai-chat");
    expect(model!.constraints.map((c) => c.id)).toContain("thinking-no-forced-tools");
  });

  it("applies route overrides for limits and pricing (owl alpha)", () => {
    const model = registry.resolve("openrouter", "openrouter/owl-alpha");
    expect(model).toBeDefined();
    expect(model!.limits.contextTokens).toBe(1048756);
    expect(model!.limits.maxOutputTokens).toBe(262144);
  });

  it("filters params on OpenRouter routes via supportedParameters", () => {
    const model = registry.resolve("openrouter", "openrouter/owl-alpha");
    // owl-alpha's supportedParameters has no min_p/top_a/verbosity-style extras;
    // every surviving canonical param must map back into the supported list
    const supported = new Set([
      "frequencyPenalty", "logitBias", "maxOutputTokens", "presencePenalty",
      "repetitionPenalty", "seed", "stopSequences", "temperature", "topK", "topP"
    ]);
    for (const name of Object.keys(model!.params)) {
      expect(supported.has(name) || name.startsWith("reasoning."), `unexpected surviving param ${name}`).toBe(true);
    }
  });

  it("resolves xiaomi base URL from route overrides", () => {
    const model = registry.resolve("xiaomi", "mimo-v2.5");
    expect(model).toBeDefined();
    expect(model!.baseUrl).toBe("https://api.xiaomimimo.com/v1");
  });

  it("returns undefined for unknown routes and collects no error-level diagnostics", () => {
    expect(registry.resolve("deepseek", "no-such-model")).toBeUndefined();
    expect(Array.isArray(registry.diagnostics())).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/registry/loader.test.ts
```
Expected: FAIL — cannot resolve `loader.js`.

- [ ] **Step 3: Write `src/registry/loader.ts`**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getProvider } from "./providers.js";
import {
  CapabilityDoc,
  ParamDescriptor,
  RegistryDiagnostic,
  ResolvedModel,
  RouteDef,
  WireProtocol
} from "./types.js";

const WIRE_DEFAULT_ENDPOINT: Record<WireProtocol, string> = {
  "openai-chat": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/v1/messages",
  "google-generative-language": ":generateContent"
};

/** OpenRouter/native wire parameter names → canonical param names. */
const WIRE_PARAM_TO_CANONICAL: Record<string, string> = {
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK",
  min_p: "minP",
  top_a: "topA",
  frequency_penalty: "frequencyPenalty",
  presence_penalty: "presencePenalty",
  repetition_penalty: "repetitionPenalty",
  logit_bias: "logitBias",
  seed: "seed",
  logprobs: "logprobs",
  top_logprobs: "topLogprobs",
  max_tokens: "maxOutputTokens",
  stop: "stopSequences",
  verbosity: "verbosity"
};

/** supportedParameters entries that gate features/params indirectly, not 1:1. */
const NON_PARAM_WIRE_NAMES = new Set([
  "tools", "tool_choice", "response_format", "structured_outputs", "reasoning", "include_reasoning"
]);

export type ModelRef = {
  providerId: string;
  modelId: string;
  family: string;
  displayName: string;
  company: string;
  wire: WireProtocol;
};

export class Registry {
  private constructor(
    private readonly docs: CapabilityDoc[],
    private readonly routeIndex: Map<string, { doc: CapabilityDoc; route: RouteDef }>,
    private readonly diags: RegistryDiagnostic[]
  ) {}

  static load(dataDir?: string): Registry {
    const dir = dataDir ?? fileURLToPath(new URL("../../data", import.meta.url));
    const docs: CapabilityDoc[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      docs.push(...(JSON.parse(readFileSync(join(dir, file), "utf8")) as CapabilityDoc[]));
    }
    const routeIndex = new Map<string, { doc: CapabilityDoc; route: RouteDef }>();
    const diags: RegistryDiagnostic[] = [];
    for (const doc of docs) {
      for (const route of doc.routes) {
        routeIndex.set(`${route.providerId} ${route.modelId}`, { doc, route });
        for (const wireName of route.overrides?.supportedParameters ?? []) {
          if (!(wireName in WIRE_PARAM_TO_CANONICAL) && !NON_PARAM_WIRE_NAMES.has(wireName)) {
            diags.push({
              level: "warning",
              family: doc.family,
              providerId: route.providerId,
              message: `unmapped supportedParameters entry "${wireName}"`
            });
          }
        }
      }
    }
    return new Registry(docs, routeIndex, diags);
  }

  listFamilies(): CapabilityDoc[] {
    return this.docs.map((d) => structuredClone(d));
  }

  listModels(): ModelRef[] {
    return this.docs.flatMap((doc) =>
      doc.routes.map((route) => ({
        providerId: route.providerId,
        modelId: route.modelId,
        family: doc.family,
        displayName: doc.displayName,
        company: doc.company,
        wire: route.wire
      }))
    );
  }

  diagnostics(): RegistryDiagnostic[] {
    return [...this.diags];
  }

  resolve(providerId: string, modelId: string): ResolvedModel | undefined {
    const entry = this.routeIndex.get(`${providerId} ${modelId}`);
    if (!entry) return undefined;
    const { doc, route } = entry;
    const o = route.overrides ?? {};
    const provider = getProvider(providerId);
    const baseUrl = o.baseUrl ?? provider?.baseUrl;
    if (!baseUrl) return undefined;

    let params: Record<string, ParamDescriptor> = structuredClone(doc.params);
    if (o.supportedParameters) {
      const canonical = new Set(
        o.supportedParameters
          .map((w) => WIRE_PARAM_TO_CANONICAL[w])
          .filter((c): c is string => c !== undefined)
      );
      const reasoningAllowed =
        o.supportedParameters.includes("reasoning") || o.supportedParameters.includes("include_reasoning");
      params = Object.fromEntries(
        Object.entries(params).filter(
          ([name]) =>
            canonical.has(name) ||
            (reasoningAllowed && name.startsWith("reasoning.")) ||
            name.includes(".") // provider-scoped params are not gated by supportedParameters
        )
      );
    }

    return {
      providerId,
      modelId,
      wire: route.wire,
      family: doc.family,
      displayName: doc.displayName,
      company: doc.company,
      baseUrl,
      endpoint: o.endpoint ?? WIRE_DEFAULT_ENDPOINT[route.wire],
      limits: {
        contextTokens: o.contextTokens ?? doc.limits.contextTokens,
        maxOutputTokens: o.maxOutputTokens ?? doc.limits.maxOutputTokens
      },
      modalities: o.modalities ? { input: [...o.modalities], output: doc.modalities.output } : structuredClone(doc.modalities),
      features: structuredClone(doc.features),
      params,
      constraints: structuredClone(doc.constraints ?? []),
      meta: {
        ...structuredClone(doc.meta),
        ...(o.pricing ? { pricing: o.pricing } : {}),
        ...(o.status ? { routeStatus: o.status } : {}),
        ...(o.note ? { routeNote: o.note } : {})
      }
    };
  }
}
```

Note on `reasoning.` filtering: `reasoning.*` params survive `supportedParameters`
filtering only when the route lists `reasoning`/`include_reasoning`; other dotted
params (provider-scoped like `google.safetySettings`) always survive — OpenRouter's
list only describes its normalized surface.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/registry/loader.test.ts
```
Expected: PASS (6 tests). If the owl-alpha param-filter test fails, print the data first (`node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync("data/openrouter.json","utf8"))[0].routes[0].overrides.supportedParameters))'`) and align the test's `supported` set with reality — the mechanism under test is the filtering, not the exact list.

- [ ] **Step 5: Run the full suite**

```bash
npm test
```
Expected: schema, providers, loader suites all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/registry/loader.ts tests/registry/loader.test.ts
git commit -m "feat: add registry loader with route-overlay resolution"
```

---

### Task 7: Constraint engine

**Files:**
- Create: `src/validate/constraints.ts`
- Test: `tests/validate/constraints.test.ts`

- [ ] **Step 1: Write the failing test `tests/validate/constraints.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { applyConstraints } from "../../src/validate/constraints.js";
import { ConstraintRule } from "../../src/registry/types.js";

const thinkingNoForcedTools: ConstraintRule = {
  id: "thinking-no-forced-tools",
  when: { param: "reasoning.enabled", eq: true },
  then: { forbid: ["toolChoice:required", "toolChoice:named"] }
};

const thinkingDropsSampling: ConstraintRule = {
  id: "thinking-drops-sampling",
  when: { param: "reasoning.enabled", eq: true },
  then: { drop: ["temperature", "topP"] }
};

describe("applyConstraints", () => {
  it("forbid with value qualifier: violation when matching", () => {
    const result = applyConstraints([thinkingNoForcedTools], { "reasoning.enabled": true, toolChoice: "required" }, new Set(["toolChoice"]));
    expect(result.violations).toEqual([
      { ruleId: "thinking-no-forced-tools", param: "toolChoice", code: "forbidden_value", value: "required" }
    ]);
  });

  it("forbid: no violation when when-clause does not match", () => {
    const result = applyConstraints([thinkingNoForcedTools], { "reasoning.enabled": false, toolChoice: "required" }, new Set(["toolChoice"]));
    expect(result.violations).toEqual([]);
  });

  it("forbid bare param: violation only when user-provided, dropped when defaulted", () => {
    const rule: ConstraintRule = { id: "r", when: { param: "reasoning.enabled", eq: true }, then: { forbid: ["presencePenalty"] } };
    const userProvided = applyConstraints([rule], { "reasoning.enabled": true, presencePenalty: 0.5 }, new Set(["presencePenalty"]));
    expect(userProvided.violations).toHaveLength(1);
    const defaulted = applyConstraints([rule], { "reasoning.enabled": true, presencePenalty: 0.5 }, new Set());
    expect(defaulted.violations).toEqual([]);
    expect(defaulted.effective).not.toHaveProperty("presencePenalty");
    expect(defaulted.warnings).toHaveLength(1);
  });

  it("drop removes the param and records a warning", () => {
    const result = applyConstraints([thinkingDropsSampling], { "reasoning.enabled": true, temperature: 0.7 }, new Set(["temperature"]));
    expect(result.violations).toEqual([]);
    expect(result.effective).not.toHaveProperty("temperature");
    expect(result.warnings).toEqual([
      { ruleId: "thinking-drops-sampling", param: "temperature", code: "dropped" }
    ]);
  });

  it("force overwrites and clamp narrows", () => {
    const rules: ConstraintRule[] = [
      { id: "f", when: { param: "reasoning.enabled", eq: true }, then: { force: { temperature: 1 } } },
      { id: "c", when: { param: "reasoning.enabled", eq: true }, then: { clamp: { topP: { max: 0.9 } } } }
    ];
    const result = applyConstraints(rules, { "reasoning.enabled": true, temperature: 0.2, topP: 0.95 }, new Set(["temperature", "topP"]));
    expect(result.effective["temperature"]).toBe(1);
    expect(result.effective["topP"]).toBe(0.9);
    expect(result.warnings.map((w) => w.code).sort()).toEqual(["clamped", "forced"]);
  });

  it("supports gt/neq/in and allOf/anyOf combinators", () => {
    const rule: ConstraintRule = {
      id: "combo",
      when: { allOf: [{ param: "a", gt: 5 }, { anyOf: [{ param: "b", neq: "x" }, { param: "c", in: [1, 2] }] }] },
      then: { drop: ["d"] }
    };
    expect(applyConstraints([rule], { a: 6, b: "y", d: 1 }, new Set(["d"])).effective).not.toHaveProperty("d");
    expect(applyConstraints([rule], { a: 4, b: "y", d: 1 }, new Set(["d"])).effective).toHaveProperty("d");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/validate/constraints.test.ts
```
Expected: FAIL — cannot resolve `constraints.js`.

- [ ] **Step 3: Write `src/validate/constraints.ts`**

```ts
import { ConstraintCondition, ConstraintRule } from "../registry/types.js";

export type ConstraintViolation = {
  ruleId: string;
  param: string;
  code: "forbidden_param" | "forbidden_value";
  value?: unknown;
};

export type ConstraintWarning = {
  ruleId: string;
  param: string;
  code: "dropped" | "forced" | "clamped";
};

export type ConstraintResult = {
  effective: Record<string, unknown>;
  violations: ConstraintViolation[];
  warnings: ConstraintWarning[];
};

function matches(condition: ConstraintCondition, params: Record<string, unknown>): boolean {
  if (condition.allOf) return condition.allOf.every((c) => matches(c, params));
  if (condition.anyOf) return condition.anyOf.some((c) => matches(c, params));
  if (condition.param === undefined) return false;
  const value = params[condition.param];
  if ("eq" in condition) return value === condition.eq;
  if ("neq" in condition) return value !== condition.neq;
  if ("gt" in condition) return typeof value === "number" && value > condition.gt!;
  if ("lt" in condition) return typeof value === "number" && value < condition.lt!;
  if ("in" in condition) return condition.in!.some((v) => v === value);
  return value !== undefined;
}

/**
 * Apply constraint rules to effective params (defaults already merged in).
 * `userProvided` lists params the caller explicitly set: forbidding a
 * user-provided param is a violation; forbidding a defaulted one drops it
 * with a warning instead.
 */
export function applyConstraints(
  rules: ConstraintRule[],
  params: Record<string, unknown>,
  userProvided: ReadonlySet<string>
): ConstraintResult {
  const effective = { ...params };
  const violations: ConstraintViolation[] = [];
  const warnings: ConstraintWarning[] = [];

  for (const rule of rules) {
    if (!matches(rule.when, effective)) continue;

    for (const entry of rule.then.forbid ?? []) {
      const sep = entry.indexOf(":");
      if (sep >= 0) {
        const param = entry.slice(0, sep);
        const value = entry.slice(sep + 1);
        if (effective[param] === value) {
          violations.push({ ruleId: rule.id, param, code: "forbidden_value", value });
        }
      } else if (effective[entry] !== undefined) {
        if (userProvided.has(entry)) {
          violations.push({ ruleId: rule.id, param: entry, code: "forbidden_param" });
        } else {
          delete effective[entry];
          warnings.push({ ruleId: rule.id, param: entry, code: "dropped" });
        }
      }
    }

    for (const param of rule.then.drop ?? []) {
      if (effective[param] !== undefined) {
        delete effective[param];
        warnings.push({ ruleId: rule.id, param, code: "dropped" });
      }
    }

    for (const [param, value] of Object.entries(rule.then.force ?? {})) {
      if (effective[param] !== value) {
        effective[param] = value;
        warnings.push({ ruleId: rule.id, param, code: "forced" });
      }
    }

    for (const [param, range] of Object.entries(rule.then.clamp ?? {})) {
      const current = effective[param];
      if (typeof current !== "number") continue;
      const clamped = Math.min(range.max ?? Infinity, Math.max(range.min ?? -Infinity, current));
      if (clamped !== current) {
        effective[param] = clamped;
        warnings.push({ ruleId: rule.id, param, code: "clamped" });
      }
    }
  }

  return { effective, violations, warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/validate/constraints.test.ts
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/validate/constraints.ts tests/validate/constraints.test.ts
git commit -m "feat: add declarative constraint engine (forbid/drop/force/clamp)"
```

---

### Task 8: Request validator

**Files:**
- Create: `src/validate/validateRequest.ts`
- Test: `tests/validate/validateRequest.test.ts`

- [ ] **Step 1: Write the failing test `tests/validate/validateRequest.test.ts`**

These tests run against the real registry — they pin the live-validated DeepSeek
behavior and the Gemini stop-sequence cap end to end.

```ts
import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";

const registry = Registry.load();

describe("validateRequest", () => {
  it("rejects forced tool choice when DeepSeek thinking is enabled (live-validated 2026-06-10)", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro")!;
    const result = validateRequest(model, { params: { "reasoning.enabled": true }, toolChoice: "required" });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === "forbidden_value" && v.param === "toolChoice")).toBe(true);
  });

  it("DeepSeek thinking defaults ON, so forced tool choice fails even without explicit reasoning param", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-flash")!;
    const result = validateRequest(model, { params: {}, toolChoice: "required" });
    expect(result.ok).toBe(false);
  });

  it("DeepSeek forced tool choice passes with thinking explicitly disabled", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-flash")!;
    const result = validateRequest(model, { params: { "reasoning.enabled": false }, toolChoice: "required" });
    expect(result.ok).toBe(true);
  });

  it("enforces Gemini's 5-stop-sequence cap", () => {
    const model = registry.resolve("google-ai-studio", "gemini-2.5-flash")!;
    const result = validateRequest(model, { params: { stopSequences: ["a", "b", "c", "d", "e", "f"] } });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === "max_items" && v.param === "stopSequences")).toBe(true);
    expect(validateRequest(model, { params: { stopSequences: ["a", "b", "c", "d", "e"] } }).ok).toBe(true);
  });

  it("rejects unknown params (GPT-5.5 has no temperature)", () => {
    const model = registry.resolve("openai", "gpt-5.5")!;
    const result = validateRequest(model, { params: { temperature: 0.7 } });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === "unknown_param" && v.param === "temperature")).toBe(true);
  });

  it("rejects out-of-range, wrong-type, and bad-enum values", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro")!;
    expect(validateRequest(model, { params: { temperature: 99 } }).violations[0]?.code).toBe("out_of_range");
    expect(validateRequest(model, { params: { temperature: "hot" } }).violations[0]?.code).toBe("wrong_type");
    expect(validateRequest(model, { params: { "reasoning.effort": "ludicrous" } }).violations[0]?.code).toBe("bad_enum");
  });

  it("rejects unsupported toolChoice modes per features", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro")!;
    const supported = model.features.tools.toolChoice ?? [];
    expect(supported).toContain("required"); // sanity: rejection below comes from constraints, not features
    const fake = { ...model, features: { ...model.features, tools: { ...model.features.tools, toolChoice: ["auto", "none"] as Array<"auto" | "none"> } } };
    const result = validateRequest(fake, { params: {}, toolChoice: "required" });
    expect(result.violations.some((v) => v.code === "unsupported_tool_choice")).toBe(true);
  });

  it("returns effective params with defaults merged", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro")!;
    const result = validateRequest(model, { params: { "reasoning.enabled": false, temperature: 0.5 } });
    expect(result.ok).toBe(true);
    expect(result.effectiveParams["temperature"]).toBe(0.5);
    expect(result.effectiveParams["reasoning.enabled"]).toBe(false);
  });
});
```

If a `resolve(...)` call returns undefined because a modelId in the test differs
from the data (e.g., the exact Gemini native id), list the real ids and fix the
test to match — the behavior under test is what matters, not the literal id:

```bash
node -e 'for (const d of JSON.parse(require("fs").readFileSync("data/google.json","utf8"))) console.log(d.routes.map(r=>r.providerId+":"+r.modelId).join("  "))'
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/validate/validateRequest.test.ts
```
Expected: FAIL — cannot resolve `validateRequest.js`.

- [ ] **Step 3: Write `src/validate/validateRequest.ts`**

```ts
import { ParamDescriptor, ResolvedModel } from "../registry/types.js";
import { applyConstraints, ConstraintViolation, ConstraintWarning } from "./constraints.js";

export type ValidateInput = {
  params: Record<string, unknown>;
  toolChoice?: "auto" | "none" | "required" | { name: string };
  responseFormat?: "json_object" | "json_schema";
  stream?: boolean;
};

export type ValidationViolation =
  | ConstraintViolation
  | {
      ruleId?: undefined;
      param: string;
      code: "unknown_param" | "wrong_type" | "out_of_range" | "bad_enum" | "max_items" | "unsupported_tool_choice" | "unsupported_response_format" | "unsupported_stream";
      message: string;
    };

export type ValidationResult = {
  ok: boolean;
  violations: ValidationViolation[];
  warnings: ConstraintWarning[];
  effectiveParams: Record<string, unknown>;
};

function checkDescriptor(name: string, value: unknown, d: ParamDescriptor): ValidationViolation | undefined {
  const wrong = (expected: string): ValidationViolation => ({
    param: name, code: "wrong_type", message: `${name} must be ${expected}`
  });
  switch (d.type) {
    case "number":
    case "int": {
      if (typeof value !== "number" || Number.isNaN(value)) return wrong("a number");
      if (d.type === "int" && !Number.isInteger(value)) return wrong("an integer");
      if ((d.min !== undefined && value < d.min) || (d.max !== undefined && value > d.max)) {
        return { param: name, code: "out_of_range", message: `${name} must be in [${d.min ?? "-inf"}, ${d.max ?? "inf"}]` };
      }
      return undefined;
    }
    case "boolean":
      return typeof value === "boolean" ? undefined : wrong("a boolean");
    case "enum":
      if (typeof value !== "string") return wrong("a string");
      if (d.values && !d.values.includes(value)) {
        return { param: name, code: "bad_enum", message: `${name} must be one of ${d.values.join(", ")}` };
      }
      return undefined;
    case "string":
      return typeof value === "string" ? undefined : wrong("a string");
    case "string[]": {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return wrong("an array of strings");
      if (d.maxItems !== undefined && value.length > d.maxItems) {
        return { param: name, code: "max_items", message: `${name} allows at most ${d.maxItems} items` };
      }
      return undefined;
    }
    case "map":
      return value !== null && typeof value === "object" && !Array.isArray(value) ? undefined : wrong("an object");
  }
}

export function validateRequest(model: ResolvedModel, input: ValidateInput): ValidationResult {
  const violations: ValidationViolation[] = [];

  // 1. unknown params + descriptor checks
  for (const [name, value] of Object.entries(input.params)) {
    if (value === undefined) continue;
    const descriptor = model.params[name];
    if (!descriptor) {
      violations.push({ param: name, code: "unknown_param", message: `${name} is not supported by ${model.providerId}:${model.modelId}` });
      continue;
    }
    const issue = checkDescriptor(name, value, descriptor);
    if (issue) violations.push(issue);
  }

  // 2. feature-level checks
  const toolChoiceMode = typeof input.toolChoice === "object" ? "named" : input.toolChoice;
  if (toolChoiceMode && toolChoiceMode !== "auto") {
    const supported = model.features.tools.supported ? (model.features.tools.toolChoice ?? ["auto"]) : [];
    if (!supported.includes(toolChoiceMode)) {
      violations.push({ param: "toolChoice", code: "unsupported_tool_choice", message: `toolChoice ${toolChoiceMode} is not supported` });
    }
  }
  if (input.responseFormat === "json_object" && !model.features.structuredOutput.jsonMode) {
    violations.push({ param: "responseFormat", code: "unsupported_response_format", message: "json_object mode is not supported" });
  }
  if (input.responseFormat === "json_schema" && !model.features.structuredOutput.jsonSchema) {
    violations.push({ param: "responseFormat", code: "unsupported_response_format", message: "json_schema mode is not supported" });
  }
  if (input.stream && !model.features.streaming) {
    violations.push({ param: "stream", code: "unsupported_stream", message: "streaming is not supported" });
  }

  // 3. effective params = defaults ∪ user params (+ normalized toolChoice/responseFormat for rules)
  const effective: Record<string, unknown> = {};
  const userProvided = new Set<string>();
  for (const [name, descriptor] of Object.entries(model.params)) {
    if (descriptor.default !== undefined) effective[name] = descriptor.default;
  }
  for (const [name, value] of Object.entries(input.params)) {
    if (value === undefined) continue;
    effective[name] = value;
    userProvided.add(name);
  }
  if (toolChoiceMode) {
    effective["toolChoice"] = toolChoiceMode;
    userProvided.add("toolChoice");
  }
  if (input.responseFormat) {
    effective["responseFormat"] = input.responseFormat;
    userProvided.add("responseFormat");
  }

  // 4. constraint rules
  const constraintResult = applyConstraints(model.constraints, effective, userProvided);
  violations.push(...constraintResult.violations);

  // 5. strip the pseudo-params back out of effective
  const { toolChoice: _tc, responseFormat: _rf, ...effectiveParams } = constraintResult.effective;

  return { ok: violations.length === 0, violations, warnings: constraintResult.warnings, effectiveParams };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/validate/validateRequest.test.ts
```
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/validate/validateRequest.ts tests/validate/validateRequest.test.ts
git commit -m "feat: add request validator combining descriptors and constraints"
```

---

### Task 9: Public exports + final verification

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write `src/index.ts`**

`schema.ts` is deliberately **not** exported: it imports zod, which is a
devDependency — exporting it from the package entry would break consumers that
don't have zod installed. It stays internal, imported only by tests.

```ts
export { Registry, type ModelRef } from "./registry/loader.js";
export { PROVIDERS, getProvider } from "./registry/providers.js";
export type {
  CapabilityDoc,
  ConstraintAction,
  ConstraintCondition,
  ConstraintRule,
  Features,
  ParamDescriptor,
  ProviderDef,
  RegistryDiagnostic,
  ResolvedModel,
  RouteDef,
  RouteOverrides,
  WireProtocol
} from "./registry/types.js";
export { applyConstraints, type ConstraintResult, type ConstraintViolation, type ConstraintWarning } from "./validate/constraints.js";
export { validateRequest, type ValidateInput, type ValidationResult, type ValidationViolation } from "./validate/validateRequest.js";
```

- [ ] **Step 2: Full verification**

```bash
npm run typecheck && npm run build && npm test
```
Expected: typecheck clean, `dist/` emitted with `.d.ts`, all 5 test files PASS (~25 tests).

- [ ] **Step 3: Verify the built package loads standalone**

```bash
node -e '
import("./dist/index.js").then(({ Registry }) => {
  const r = Registry.load();
  const m = r.resolve("deepseek", "deepseek-v4-pro");
  console.log(r.listFamilies().length, "families;", m.constraints.length, "constraints on v4-pro");
});'
```
Expected: `54 families; 2 constraints on v4-pro`.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: define public package exports"
```

---

## Execution record (2026-06-10)

**P1a COMPLETE and signed off** — 16 commits on `waifucave-gateway` main (root `39da171` → `1219374`), 32 tests green, typecheck/build clean, `npm pack` produces a working 19.3kB artifact. Executed subagent-driven with two-stage review per task. Notable deviations from this plan, all reviewer-driven:

- `meta.availability?: string` added to types/schema (23 docs carry it; my data audit missed it).
- Mistral `toolChoice: "any"` normalized out of `data/mistral.json` (redundant alias of `required`). **The gateway repo's `data/` is now authoritative**; `research/p0-capability-docs/` in this repo is a historical snapshot.
- Loader: provider-scoped dotted params (e.g. `google.safetySettings`) are now DROPPED on routes with `supportedParameters` (the plan's escape hatch let them leak onto OpenRouter routes). Duplicate-route warning diagnostics added.
- Validator: pseudo-param injection now shadow-restores real params (OpenAI/Moonshot carry a genuine `responseFormat` map param the strip was silently eating).
- `RouteOverrides.maxOutputTokens` is `number | null`; recursive condition schema typed `z.ZodType<ConstraintCondition>`.

**P1b carryover (from final review, non-blocking):**
1. Google wire seam: `baseUrl + endpoint` is NOT a complete URL for `google-generative-language` — transport must build `{baseUrl}/v1beta/models/{modelId}:generateContent` (+ `:streamGenerateContent`), branching on `wire`. Add a `buildUrl(model)` helper.
2. Packaging: `dist/registry/schema.js` (zod import) ships in the tarball; deep-importers/bundlers could trip. Carve it out of the published build.
3. Constraint engine: `force`/`drop`/`clamp` on injected pseudo-params is discarded by shadow-restore (no data rule does this today) — add a guard/test if such a rule appears.
4. Consider exporting `ParamType`/`Confidence` if codecs need to switch on descriptor types.
5. P1b client must gate on `ok` before consuming `effectiveParams` (documented on the type).

## Self-review notes (completed during planning)

- **Spec coverage vs MIGRATION_PLAN P1:** registry ✅ (Tasks 2–6), validate ✅ (7–8); codecs/transport/client → P1b plan; server/sync → P1c plan. P1 exit criteria split accordingly: P1a's slice is "registry loads 54 docs, validation pins the Table A quirks that exist in data".
- **Type consistency:** `ResolvedModel.constraints` is non-optional (loader fills `[]`), so `validateRequest` needs no null-guard; `applyConstraints(model.constraints, ...)` matches. `ValidationViolation` unions `ConstraintViolation` — both use `param`/`code`.
- **Known judgment calls encoded above:** forbid-on-defaulted-param degrades to drop+warning (DeepSeek thinking defaults ON — erroring on every defaulted request would make `required` unusable even for users who never asked for thinking); provider-scoped dotted params bypass `supportedParameters` filtering; `schema.ts` not exported (zod stays dev-only).
