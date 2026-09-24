import path from "node:path";
import { z } from "zod";
import {
  RemoteDaemonStateSchema,
  type RemoteDaemonState
} from "../shared/schemas/remoteRuntime.js";
import { atomicWriteJson } from "../storage/atomic.js";
import { IdentityResetState } from "../backend/remoteAccess/identityResetState.js";
import { remoteRolePaths } from "./paths.js";

export const RemoteDaemonStartupHandoffSchema = z.object({
  runtime: RemoteDaemonStateSchema,
  bootstrapUrl: z.string().url()
}).strict().superRefine((value, context) => {
  const url = new URL(value.bootstrapUrl);
  if (
    url.origin !== value.runtime.connectionShellOrigin
    || !/^\/_waifus_remote\/bootstrap\/[A-Za-z0-9_-]{43}$/u.test(url.pathname)
    || url.search !== ""
    || url.hash !== ""
    || url.username !== ""
    || url.password !== ""
    || url.href !== value.bootstrapUrl
  ) {
    context.addIssue({
      code: "custom",
      path: ["bootstrapUrl"],
      message: "Remote startup bootstrap URL must be an exact tokenized path on the shell origin."
    });
  }
});

export type RemoteDaemonStartupHandoff = z.infer<
  typeof RemoteDaemonStartupHandoffSchema
>;

export async function publishRemoteDaemonStartup(input: Readonly<{
  dataRoot: string;
  runtime: RemoteDaemonState;
  bootstrapUrl: string;
}>): Promise<void> {
  const dataRoot = path.resolve(input.dataRoot);
  const handoff = RemoteDaemonStartupHandoffSchema.parse({
    runtime: input.runtime,
    bootstrapUrl: input.bootstrapUrl
  });
  if (handoff.runtime.dataRoot !== dataRoot) {
    throw new TypeError("Remote daemon startup state belongs to another data root.");
  }
  const paths = remoteRolePaths(dataRoot, "remote");
  await new IdentityResetState(dataRoot).runWhileIdle(async () => {
    await atomicWriteJson(paths.runtimePid, handoff.runtime, { mode: 0o600 });
    await atomicWriteJson(paths.runtimeState, handoff.runtime, { mode: 0o600 });
    // Publish the one-use token only after the complete process state is durable. The detached
    // parent consumes and removes this owner-only handoff before opening a browser.
    await atomicWriteJson(paths.startupHandoff, handoff, { mode: 0o600 });
  });
}

/** Refresh the public, sanitized status without minting another browser bootstrap token. */
export async function publishRemoteDaemonState(input: Readonly<{
  dataRoot: string;
  runtime: RemoteDaemonState;
}>): Promise<void> {
  const dataRoot = path.resolve(input.dataRoot);
  const runtime = RemoteDaemonStateSchema.parse(input.runtime);
  if (runtime.dataRoot !== dataRoot) {
    throw new TypeError("Remote daemon state belongs to another data root.");
  }
  const paths = remoteRolePaths(dataRoot, "remote");
  await new IdentityResetState(dataRoot).runWhileIdle(async () => {
    await atomicWriteJson(paths.runtimeState, runtime, { mode: 0o600 });
  });
}
