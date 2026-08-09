import {
  WIPC_AUTH_VALUE_BYTES,
  WipcProtocolError,
  deriveWipcHelperProof,
  deriveWipcParentProof,
  verifyWipcHelperProof,
  verifyWipcParentProof
} from "./wipc.js";

export interface WipcParentAuthSessionOptions {
  parentCapability: Uint8Array;
  clientNonce: Uint8Array;
  helloBytes: Uint8Array;
}

export interface WipcParentCandidateInput {
  helperNonce: Uint8Array;
  helloAckBytes: Uint8Array;
}

export interface WipcHelperAuthSessionOptions {
  parentCapability: Uint8Array;
}

export interface WipcHelperCandidateInput {
  clientNonce: Uint8Array;
  helperNonce: Uint8Array;
  helloBytes: Uint8Array;
  helloAckBytes: Uint8Array;
  parentProof: Uint8Array;
}

interface ParentCandidate {
  helperNonce: Buffer;
  helloAckBytes: Buffer;
  parentProof: Buffer;
}

function authError(
  code:
    | "invalid_auth_width"
    | "auth_sequence_error"
    | "invalid_parent_proof"
    | "invalid_helper_proof"
    | "auth_capability_unavailable"
    | "frame_before_authentication",
  message: string
): never {
  throw new WipcProtocolError(code, message);
}

function copyCapability(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== WIPC_AUTH_VALUE_BYTES) {
    authError("invalid_auth_width", "parentCapability must contain exactly 32 bytes.");
  }
  return Buffer.from(value);
}

function erase(value: Buffer | null): void {
  value?.fill(0);
}

export class WipcParentAuthSession {
  #parentCapability: Buffer | null;
  readonly #clientNonce: Buffer;
  readonly #helloBytes: Buffer;
  #candidate: ParentCandidate | null = null;
  #authenticated = false;

  constructor(options: WipcParentAuthSessionOptions) {
    this.#parentCapability = copyCapability(options.parentCapability);
    this.#clientNonce = Buffer.from(options.clientNonce);
    this.#helloBytes = Buffer.from(options.helloBytes);
  }

  get authenticated(): boolean {
    return this.#authenticated;
  }

  get capabilityAvailable(): boolean {
    return this.#parentCapability !== null;
  }

  beginCandidate(input: WipcParentCandidateInput): Buffer {
    const capability = this.#requireCapability();
    if (this.#candidate) {
      authError("auth_sequence_error", "A parent authentication candidate is already active.");
    }
    const helperNonce = Buffer.from(input.helperNonce);
    const helloAckBytes = Buffer.from(input.helloAckBytes);
    const parentProof = deriveWipcParentProof({
      parentCapability: capability,
      clientNonce: this.#clientNonce,
      helperNonce,
      helloBytes: this.#helloBytes,
      helloAckBytes
    });
    this.#candidate = { helperNonce, helloAckBytes, parentProof };
    return Buffer.from(parentProof);
  }

  completeCandidate(helperProof: Uint8Array): void {
    const capability = this.#requireCapability();
    const candidate = this.#candidate;
    if (!candidate) {
      authError("auth_sequence_error", "No parent authentication candidate is awaiting helper proof.");
    }
    let verified: boolean;
    try {
      verified = verifyWipcHelperProof({
        parentCapability: capability,
        clientNonce: this.#clientNonce,
        helperNonce: candidate.helperNonce,
        helloBytes: this.#helloBytes,
        helloAckBytes: candidate.helloAckBytes,
        parentProof: candidate.parentProof,
        helperProof
      });
    } catch (error) {
      this.#clearCandidate();
      throw error;
    }
    if (!verified) {
      this.#clearCandidate();
      authError("invalid_helper_proof", "Helper proof does not match this exact WIPC transcript.");
    }
    this.#authenticated = true;
    this.#clearCandidate();
    erase(this.#parentCapability);
    this.#parentCapability = null;
  }

  assertTrafficAllowed(): void {
    if (!this.#authenticated) {
      authError(
        "frame_before_authentication",
        "No command, event, or stream traffic is allowed before helper proof succeeds."
      );
    }
  }

  #requireCapability(): Buffer {
    if (!this.#parentCapability) {
      authError(
        "auth_capability_unavailable",
        "The one-launch parent capability has already been consumed and erased."
      );
    }
    return this.#parentCapability;
  }

  #clearCandidate(): void {
    if (!this.#candidate) {
      return;
    }
    erase(this.#candidate.helperNonce);
    erase(this.#candidate.helloAckBytes);
    erase(this.#candidate.parentProof);
    this.#candidate = null;
  }
}

export class WipcHelperAuthSession {
  #parentCapability: Buffer | null;
  #authenticated = false;

  constructor(options: WipcHelperAuthSessionOptions) {
    this.#parentCapability = copyCapability(options.parentCapability);
  }

  get authenticated(): boolean {
    return this.#authenticated;
  }

  get capabilityAvailable(): boolean {
    return this.#parentCapability !== null;
  }

  authenticateCandidate(input: WipcHelperCandidateInput): Buffer {
    const capability = this.#requireCapability();
    const verified = verifyWipcParentProof({
      parentCapability: capability,
      clientNonce: input.clientNonce,
      helperNonce: input.helperNonce,
      helloBytes: input.helloBytes,
      helloAckBytes: input.helloAckBytes,
      parentProof: input.parentProof
    });
    if (!verified) {
      authError("invalid_parent_proof", "Parent proof does not match this exact WIPC transcript.");
    }
    const helperProof = deriveWipcHelperProof({
      parentCapability: capability,
      clientNonce: input.clientNonce,
      helperNonce: input.helperNonce,
      helloBytes: input.helloBytes,
      helloAckBytes: input.helloAckBytes,
      parentProof: input.parentProof
    });
    this.#authenticated = true;
    erase(this.#parentCapability);
    this.#parentCapability = null;
    return helperProof;
  }

  assertTrafficAllowed(): void {
    if (!this.#authenticated) {
      authError(
        "frame_before_authentication",
        "No command, event, or stream traffic is allowed before parent proof succeeds."
      );
    }
  }

  #requireCapability(): Buffer {
    if (!this.#parentCapability) {
      authError(
        "auth_capability_unavailable",
        "The one-launch helper capability has already been consumed and erased."
      );
    }
    return this.#parentCapability;
  }
}
