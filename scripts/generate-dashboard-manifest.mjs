import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeDashboardManifest } from "../src/remote/dashboardManifest.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8")
);

if (typeof packageJson.version !== "string") {
  throw new TypeError("package.json version must be a SemVer string.");
}

await writeDashboardManifest({
  bundleDirectory: path.join(repositoryRoot, "dist-frontend"),
  discordWaifusVersion: packageJson.version,
  minimumHelperVersion: "0.1.0",
  minimumRemoteGatewayVersion: packageJson.version
});
