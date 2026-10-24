// Write-time validation of provider ids and model choices against the winter catalog (Living cast
// spec §9.2):
//   - unknown provider id (credentials PUT)                         -> 400 unknown_provider
//   - a model route the curated catalog does not offer               -> 400 model_not_available
//   - an effort the route does not list                              -> 400 unsupported_effort
// Validation needs no credentials and makes no network call.

import { catalogProvider, curatedCatalog, findCuratedModel, routeKey, type CuratedCatalogOptions } from "../models/catalog.js";
import type { ModelChoice } from "../shared/schemas/domain.js";
import { badRequest } from "./errors.js";

/** Non-model credentials the app stores beside the model keys (Living cast §6.8: the Exa key). */
export const APP_CREDENTIAL_PROVIDERS: Readonly<Record<string, { displayName: string; docsUrl: string }>> = {
  exa: { displayName: "Exa (web search)", docsUrl: "https://docs.exa.ai/reference/getting-started" }
};

/** A winter catalog LLM provider or an app credential provider (`exa`); anything else is refused. */
export function assertKnownProvider(providerId: string): void {
  if (Object.hasOwn(APP_CREDENTIAL_PROVIDERS, providerId)) return;
  const provider = catalogProvider(providerId);
  if (!provider || provider.scope !== "llm") {
    throw badRequest(`Unknown provider: ${providerId}`, { error: "unknown_provider", providerId });
  }
}

/** Asserts `choice` is an offered curated route and its effort (if any) is one the route lists. */
export function assertModelChoiceValid(choice: ModelChoice, options: CuratedCatalogOptions = {}): void {
  const curated = curatedCatalog(options);
  const model = findCuratedModel(choice, curated);
  if (!model) {
    const id = routeKey(choice);
    const hidden = curated.hidden.find((entry) => entry.id === id);
    throw badRequest(`Model ${id} is not offered${hidden ? ` (${hidden.reason})` : ""}.`, {
      error: "model_not_available",
      providerId: choice.providerId,
      modelId: choice.modelId,
      ...(hidden ? { reason: hidden.reason } : {})
    });
  }
  if (choice.effort !== undefined && !model.efforts.includes(choice.effort)) {
    throw badRequest(`Effort ${choice.effort} is not supported by ${model.id}.`, {
      error: "unsupported_effort",
      effort: choice.effort,
      efforts: model.efforts
    });
  }
}
