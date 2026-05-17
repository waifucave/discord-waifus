import { parseCliArgs } from "./parser.js";
import { runCommand } from "./commands.js";

const parsed = parseCliArgs(process.argv.slice(2));

try {
  const code = await runCommand(parsed);
  process.exitCode = code;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
