# Providers & Models

How API keys, the model registry, and per-model parameters work.

## Providers

A provider is a model API vendor (deepseek, anthropic, openai, google-ai-studio, xai, mistral,
qwen, and more). Keys are stored locally in `user/providers.json` and are **write-only** through
the API: `GET /api/providers` returns configured/not-configured plus a redacted hint, never the
key itself. Set a key with `PUT /api/providers/:providerId/credentials {"apiKey": "..."}`;
remove with DELETE on the same path.

## The model registry (gateway)

The app has no hand-maintained model list. All models, capabilities, and parameter rules come
from the `@waifucave/gateway` registry, exposed under `/api/llm/*`. For each model the registry
knows: context window, max output, modalities (text/image), tool support and tool-choice modes,
reasoning support, sampling parameters with ranges/defaults, and cross-parameter constraint
rules (for example: Anthropic and DeepSeek models reject forced tool choice while thinking is
enabled — the app automatically disables thinking on such calls).

## Choosing models per role

- **Orchestrator** — needs solid tool-calling and reasoning about social context; every pass is
  one forced tool call. Fast, cheap models with good judgment work well.
- **Waifus** — each waifu has her own `(providerId, modelId)`; personality quality dominates.
  Only waifus on vision-capable models see images natively; others get OCR transcripts.
- **Stage-manager** — summarization/observation work, forced tool calls; a small model is fine.
  Thinking/reasoning buys nothing here (every call forces a tool) — leave it off.
- **Reviewer** — tiny classification calls; the cheapest reliable model is fine.
- **Assistant** — the dashboard helper; defaults to the orchestrator's model until set.

## Params

Configs store gateway-native dotted params, e.g. `temperature`, `topP`,
`reasoning.enabled`, `reasoning.effort`, `reasoning.budgetTokens`. Writes are validated against
the registry: an unsupported parameter or value returns HTTP 400 naming the violated rule.
The chat path is lenient: stored params that conflict with a specific call shape (like thinking
with a forced tool) are auto-corrected per call rather than failing.
