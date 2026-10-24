# Providers & Models

How API keys, the curated model list and reasoning effort work.

## Providers

A provider is a model API vendor (anthropic, openai, deepseek, meta, openrouter, and the others the
winter catalog knows). Keys are stored locally in `user/providers.json` and are **write-only**
through the API: `GET /api/providers` returns configured/not-configured plus a redacted hint, never
the key itself. Set a key with `PUT /api/providers/:providerId/credentials {"apiKey": "..."}`;
remove with DELETE on the same path. An unknown provider id is refused (`unknown_provider`).
`GET /api/providers` lists the providers that serve curated models, the detector's providers
(openai, openrouter) and any provider that already has a key.

## The curated model list

Model facts (context window, output limit, image input, reasoning efforts, prices) come from the
winter provider catalog installed with the app. The app offers a short curated list on top of it:
`GET /api/models` returns every offered route as `{providerId, modelId}` with its display name,
the reasoning efforts it accepts, its price, whether it is a contributor variant, and whether its
provider has a key. Routes the list names but the installed catalog lacks, routes above the price
cap (`config.toml` `[models] maxOutputUsdPerMTok`, default $10 per million output tokens) and
OpenRouter routes (until the installed winter can replay reasoning through OpenRouter) are listed
under `hidden` with the reason.

The curated families: Muse Spark (contributor), Claude Haiku and Sonnet, DeepSeek Flash, GPT Luna
and GPT Sol — each directly from its vendor and through OpenRouter.

**Contributor variants** (Muse Spark `-contributor`) share prompts with the vendor for training.
Only pick one when the user explicitly asks for it.

## Choosing a model

- **Waifus** — each waifu has her own `model: {providerId, modelId, effort?}`; personality quality
  dominates. Waifus on image-capable models see images natively; others get OCR text.
- **Assistant** — the dashboard helper; `PUT /api/assistant/config {"model": ...}`. Unset, it uses
  the first configured waifu's model.

`effort` must be one of the efforts `GET /api/models` lists for that route (for example
`low`/`high`/`max`); omit it for the route's default. A stored effort the installed catalog no
longer lists is dropped at boot and reported in `GET /api/runtime` → `models.warnings`.

## Upgrades from the gateway era

The old per-model `params` (temperature etc.) are gone. At upgrade, each waifu's model was mapped
to its curated family (for example any Claude Sonnet → `anthropic/claude-sonnet-5-5`, any
DeepSeek Flash → `deepseek/deepseek-flash`) and a stored reasoning effort carried over. A model with
no curated family (Opus, `-pro` tiers, other vendors) was unset and is listed in
`models.warnings` as `model_unmapped`: pick a new model for that waifu.

## Secrets without exposure

The `request_secret` tool shows the user a secure input form in the dashboard panel. The
secret (provider API key or bot token) is posted by the browser directly to storage and
never enters the assistant conversation. Always prefer it over asking for secrets in chat;
application IDs are not secret and can be set via `link_waifu_bot` (for characters) or
`update_discord_bots`.
