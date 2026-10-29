// The benchmark's scenarios (spec §33.1). `tiny` is the tests' and the quick smoke check's; the
// other three are the first real scenarios.

import type { Scenario } from "../scenario.js";
import busyBurst from "./busyBurst.js";
import dmPrivate from "./dmPrivate.js";
import smallServer from "./smallServer.js";
import tiny from "./tiny.js";

export const SCENARIOS: readonly Scenario[] = [smallServer, dmPrivate, busyBurst, tiny];

/** The default selection: the real scenarios, not the smoke one. */
export const DEFAULT_SCENARIOS: readonly string[] = [smallServer.id, dmPrivate.id, busyBurst.id];

export function selectScenarios(spec: string): Scenario[] {
  const ids = spec === "" || spec === "default" ? DEFAULT_SCENARIOS : spec === "all" ? SCENARIOS.map((scenario) => scenario.id) : spec.split(",").map((id) => id.trim()).filter(Boolean);
  return ids.map((id) => {
    const scenario = SCENARIOS.find((entry) => entry.id === id);
    if (!scenario) throw new Error(`Unknown scenario ${id} (have: ${SCENARIOS.map((entry) => entry.id).join(", ")})`);
    return scenario;
  });
}
