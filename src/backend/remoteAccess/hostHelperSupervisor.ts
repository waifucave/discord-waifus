import { RemoteComponentCompatibilityError } from "../../remote/componentCompatibility.js";
import { supportedHelperTarget } from "../../remote/helperBinary.js";
import {
  createProductionHelperSupervisor,
  type CreateProductionHelperSupervisorOptions
} from "../../remote/productionHelper.js";
import {
  HelperSupervisorError,
  type HelperActivationCancel,
  type HelperActivationPoll,
  type HelperActivationStart,
  type HelperSupervisorSnapshot
} from "../../remote/helperTypes.js";
import {
  RemoteAccessErrorCodeSchema,
  type RemoteAccessErrorCode
} from "../../shared/schemas/remoteLifecycle.js";
import type { HelperSupervisorController } from "./remoteAccessService.js";

const UNAVAILABLE_MESSAGE = "Remote access is unavailable on this installation.";

/**
 * Fail-closed stand-in used when the production helper supervisor cannot be
 * constructed (unsupported platform, unusable compatibility table, ...).
 *
 * Remote Access is optional: the host must boot and serve the local bot even
 * then. Every helper operation rejects with the recorded closed-enum reason, so
 * enabling or activating remote access surfaces that reason instead of
 * launching anything or crashing the host process.
 */
export class UnavailableHelperSupervisor implements HelperSupervisorController {
  readonly #reason: RemoteAccessErrorCode;
  readonly #snapshot: HelperSupervisorSnapshot;

  constructor(reason: RemoteAccessErrorCode) {
    this.#reason = RemoteAccessErrorCodeSchema.parse(reason);
    this.#snapshot = Object.freeze({
      state: "disabled",
      helperVersion: null,
      releaseSequence: null,
      forkCommit: null,
      target: null,
      protocol: null,
      capabilities: Object.freeze([]),
      runtimeStatus: Object.freeze({
        activationState: "activation_required",
        controlState: "inactive",
        directState: "inactive",
        lastDirectAt: null,
        lastErrorCode: this.#reason
      }),
      lastErrorCode: this.#reason,
      consecutiveFailures: 0,
      restartScheduled: false
    });
  }

  /** Map a construction failure onto a closed enum code; never forward its message. */
  static reasonFor(error: unknown): RemoteAccessErrorCode {
    if (error instanceof RemoteComponentCompatibilityError) return "helper_incompatible";
    const candidate = error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
    const parsed = RemoteAccessErrorCodeSchema.safeParse(candidate);
    return parsed.success ? parsed.data : "helper_unavailable";
  }

  unavailableReason(): RemoteAccessErrorCode {
    return this.#reason;
  }

  snapshot(): HelperSupervisorSnapshot {
    return this.#snapshot;
  }

  identityStatus(): null {
    return null;
  }

  subscribe(): () => void {
    return () => undefined;
  }

  attachRequestBridge(): void {
    // No helper will ever carry remote requests; the bridge stays unused.
  }

  async start(): Promise<void> {
    throw this.#error();
  }

  async stop(): Promise<void> {}

  async reconnect(): Promise<void> {
    throw this.#error();
  }

  async startRuntime(): Promise<HelperSupervisorSnapshot["runtimeStatus"]> {
    throw this.#error();
  }

  async runtimeStatus(): Promise<HelperSupervisorSnapshot["runtimeStatus"]> {
    throw this.#error();
  }

  async reconnectRuntime(): Promise<HelperSupervisorSnapshot["runtimeStatus"]> {
    throw this.#error();
  }

  async stopRuntime(): Promise<HelperSupervisorSnapshot["runtimeStatus"]> {
    throw this.#error();
  }

  async registerGatewayLaunch(): Promise<void> {
    throw this.#error();
  }

  async beginActivation(): Promise<HelperActivationStart> {
    throw this.#error();
  }

  async pollActivation(): Promise<HelperActivationPoll> {
    throw this.#error();
  }

  async cancelActivation(): Promise<HelperActivationCancel> {
    throw this.#error();
  }

  async close(): Promise<void> {}

  #error(): HelperSupervisorError {
    return new HelperSupervisorError(this.#reason, UNAVAILABLE_MESSAGE);
  }
}

/**
 * Construct the host-role helper supervisor without ever failing host boot.
 * Construction only binds the shipped compatibility table and platform target;
 * no helper is launched here. On failure the returned supervisor rejects every
 * helper operation, so Remote Access still fails closed when it is enabled.
 */
export async function createHostHelperSupervisor(
  options: CreateProductionHelperSupervisorOptions
): Promise<HelperSupervisorController> {
  try {
    supportedHelperTarget(
      options.platform ?? process.platform,
      options.arch ?? process.arch,
      options.armVersion
    );
    return await createProductionHelperSupervisor(options);
  } catch (error) {
    const code = UnavailableHelperSupervisor.reasonFor(error);
    options.logger.warn("Remote access helper unavailable", { role: options.role, code });
    return new UnavailableHelperSupervisor(code);
  }
}
