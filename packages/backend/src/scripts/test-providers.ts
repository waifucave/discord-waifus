import path from "node:path";
import { fileURLToPath } from "node:url";
import { AIRouter } from "../ai-router.js";
import { ConfigManager } from "../config-manager.js";

async function main(): Promise<void> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = path.resolve(currentDir, "../../../../");
  const config = new ConfigManager(workspaceRoot);
  await config.load();

  const router = new AIRouter(config.providers.filter((provider) => provider.enabled));
  const providers = config.providers.filter((provider) => provider.enabled);

  if (providers.length === 0) {
    console.log("No enabled providers found.");
    return;
  }

  for (const provider of providers) {
    const model = provider.models[0];
    if (!model) {
      console.log(`[skip] ${provider.id}: no model configured`);
      continue;
    }

    try {
      const completion = await router.complete({
        providerId: provider.id,
        model,
        messages: [
          {
            role: "user",
            content: "Say hello in one sentence."
          }
        ],
        maxTokens: 40,
        timeoutMs: 20_000
      });

      console.log(`[ok] ${provider.id}/${model}: ${completion.content.trim()}`);
    } catch (error) {
      console.error(`[fail] ${provider.id}/${model}:`, error);
    }
  }
}

void main();
