# Waifus Remote Management — Contracts and Security Baseline

> **For agentic workers:** implement this document task-by-task with test-driven development. Do not begin helper, Cloudflare, host bridge, or remote-gateway production work until the contract and security gates in this document pass.

**Goal:** Freeze the public contracts and make the existing trusted-local Fastify application safe to receive authenticated remote-admin requests later, without exposing any remote listener yet.

**Architecture:** Every request receives a non-forgeable actor principal, every registered route has reviewed remote/retry/field metadata, browser requests are same-origin and CSRF-bound, all mutations pass through durable operation and audit primitives, and all live streams use epoch-aware cursors. These primitives land and pass locally before `ts-connect` is allowed to dispatch a remote request.

**Source of truth:** `docs/superpowers/specs/2026-08-06-waifus-remote-management-design.md` and current `CLAUDE.md`.

## Locked decisions and constants

- The committed design is authoritative: an already trusted `remote_device` full administrator **may** create and approve another remote, but only through exact actor/session-bound confirmation and full audit. Host identity reset and host bind/filesystem exposure remain local-only.
- `pair.waifucave.com` carries bounded coordination metadata over its own HTTPS/WSS endpoints only.
  No host-application HTTP, SSE, dashboard asset, application-WebSocket, WireGuard, or helper IPC
  payload may use it as a relay.
- Protocol versions start at `major: 1, minor: 0`. Unknown major versions fail closed. Unknown required capabilities fail closed; unknown optional minor capabilities are ignored.
- Every uint64 carried in JSON—including trust/key/origin epochs, generations, sequences, sizes,
  and release counters—is a canonical shortest unsigned decimal string (`0` or no leading zero) and
  is parsed to `bigint` for arithmetic. JSON numbers, exponent notation, values above
  `18446744073709551615`, and negative/leading-zero forms are rejected. Fixed binary/CBOR contracts
  retain their exact uint64 encoding; JavaScript never narrows them through `number`.
- Security-sensitive protocol Zod objects use `.strict()` and explicit byte/count limits. Ordinary legacy app schemas retain their current compatibility behavior unless a task explicitly changes them.
- Pair invitations expire after five minutes. Full invitations contain at least 128 random bits unknown to Cloudflare. Pairing secrets are never URL query parameters.
- Implementation constants chosen by this plan: each host browser server and remote gateway creates
  a fresh 32-byte browser-server launch ID; browser sessions use 32 random bytes, bind to that
  launch, rotate on each server launch, use `HttpOnly`, `SameSite=Strict`, host-only cookies, a
  30-minute idle timeout, and an eight-hour absolute timeout. CSRF tokens use 32 random bytes and
  are bound to the browser session.
- Local browser origins are the exact effective loopback origin. Development additionally allows exactly `http://127.0.0.1:5173` and `http://localhost:5173` only in `mode: "dev"`; there is no wildcard origin.
- Idempotency keys are 16–128 printable ASCII characters. The lookup identity is `actor stable ID +
  trust epoch + method + route template + RFC8785(validated path params) +
  RFC8785(mutation-semantic query) + key`. The stored request fingerprint is the SHA-256 canonical
  body hash. Thus the same concrete target/key with a changed body is `409`, while a different
  concrete target is an independent operation. Params and semantic query are typed values with sorted
  keys; transport-only query fields are excluded explicitly by route policy, never accidentally.
- Completed operation receipts live for 24 hours; unresolved `prepared`/`outcome_unknown` receipts live for 30 days. The shared store is capped when either 10,000 entries or 32 MiB is reached, and each stored result is capped at 64 KiB. Capacity cleanup removes only TTL-expired records, never unexpired completed/prepared/unknown receipts; a cap full of unexpired records makes new mutations fail closed. The store contains hashes and redacted results, never request bodies or secrets.
- Administrative audit retention is 90 days with an additional maximum of 50,000 events or 64 MiB, whichever bound is reached first. Each entry is capped at 64 KiB and is written mode `0600`.
- If a required operation intent or mandatory administrative-audit entry cannot be persisted, the mutation fails closed before its application effect begins.
- SSE uses an exactly 128-random-bit `streamEpoch`, an unsigned monotonic `sequence`, and a replay ring capped when either 2,000 events or 8 MiB per stream is reached. The SSE `id` is exactly `v1:<base64url-unpadded 16-byte epoch>:<decimal sequence>`. Implementation constants chosen by this plan: individual events are capped at 256 KiB and authorization-checking heartbeats run every 15 seconds.
- Existing prompt/query/reply visibility remains available to a full administrator, but the final serialization path always redacts credentials, Discord tokens, pairing material, endpoint plaintext, internal capabilities, and private keys.
- `waifus clean` refuses while either the host or remote daemon is running. Once stopped, it preserves host remote-access enabled/settings state, installation identity, activation credential, trusted pairs, deny/trust epochs, remembered hosts, bounded operation receipts, and administrative audit. It removes ordinary user/config/cache data, including verified dashboard caches, and prints the preserved pairing count plus an explicit local reset instruction pointing to Settings → Remote Access.
- The separate typed identity reset is installation-wide for one canonical data root. It may run
  inside the current local host process but fails without mutation if that root's sibling remote
  gateway/helper is live. It resets both roles' identity/trust state and remembered hosts while
  preserving the bounded operation ledger, administrative audit, and a monotonic reset tombstone;
  exact helper/vault shutdown and route ordering lands in the host API plan.

## Dependency and release gates

1. Tasks 1–6 below are sequential. Tests introduced by an earlier task remain required by every later task.
2. The public contract fixtures from Task 1 must be consumed by the private helper's Go conformance tests before production IPC or coordination work.
3. No request from `ts-connect` may reach an application handler until Tasks 2–6 pass and the streaming bridge spike in `05-host-api-and-bridge.md` passes.
4. This document introduces no public listener, no Cloudflare deployment, no repository creation, no npm package publication, and no helper optional dependency.

---

### Task 1: Freeze public contracts and capability negotiation

**Files:**

- Create: `src/shared/schemas/remoteProtocol.ts`
- Create: `src/shared/schemas/remoteAccess.ts`
- Create: `contracts/remote/v1/protocol.schema.json`
- Create: `contracts/remote/v1/remote-access.schema.json`
- Create: `contracts/remote/v1/helper-manifest.schema.json`
- Create: `contracts/remote/v1/capabilities.json`
- Create: `contracts/remote/v1/pairing.md`
- Create: `contracts/remote/v1/fixtures/crypto/*.json`
- Create: `contracts/remote/v1/fixtures/helper-manifest/{valid,invalid}/*.json`
- Create: `contracts/remote/v1/fixtures/valid/*.json`
- Create: `contracts/remote/v1/fixtures/invalid/*.json`
- Create: `contracts/remote/v1/README.md`
- Create: `contracts/wordlists/sas-v1.txt`
- Create: `contracts/wordlists/README.md`
- Create: `contracts/remote/v1/conformance-go/go.mod`, `go.sum`
- Create: `contracts/remote/v1/conformance-go/cmd/generate-vectors/main.go`
- Create: `contracts/remote/v1/conformance-go/conformance/*_test.go`
- Test: `tests/remoteProtocolSchemas.test.ts`
- Test: `tests/remoteAccessSchemas.test.ts`
- Test: `tests/remotePairingVectors.test.ts`

**Interfaces to lock:**

- `Uint64DecimalSchema`, `ProtocolVersionSchema`, `CapabilitySetSchema`, `ComponentHelloSchema`, `CompatibilityResultSchema`
- `ControlProfileV1Schema` is the closed numeric enum `1=production`, `2=staging`, paired with
  `RuntimePurposeSchema` (`normal | development | release_validation`) in authenticated helper
  HELLO. Normal app runtime accepts only production; no schema contains an arbitrary control URL.
- Strict request/response/cancel/stream frame envelopes and error codes matching the frozen 24-byte `WIPC` header: canonical-JSON control payloads at most 32 KiB, encoded headers at most 16 KiB, raw data frames at most 64 KiB, and 128 concurrent streams per connection. Binary stream bytes remain out-of-band from JSON control fields. Public byte fixtures pin both capability-derived `parentProof` and `helperProof`; no traffic is accepted before mutual parent/helper authentication completes. Each initiating side uses its fixed stream-ID parity and strictly increasing uint64 IDs; the receiver retains only that side's high-water mark, rejects an ID at or below it, and closes before wrap rather than retaining an unbounded tombstone set or reusing an ID.
- `DeviceIdentityBundleSchema`, `RequestPrincipalWireSchema`, `RemoteBrowserContextV1Schema`,
  public-key fingerprints, trust epochs, key sequences, and actor/delegation identifiers. The browser
  context carries a helper-verified proof bound to device/trust epoch, application/direct session and
  stream, gateway launch, exact browser session, per-request nonce, CSRF result, method, and canonical
  concrete target; it is never accepted from ordinary HTTP headers.
- Strict dashboard manifest, helper binary manifest, remote status/config, activation, invitation, pending-pair, `ApprovalReceiptV1`, trusted-device, diagnostics, operation, audit, stream cursor, and client-context DTOs.
- Gateway-local `PairStartResult` and pair-operation status/cancel DTOs use a separate 32-byte local
  operation ID. The secure same-session detail response owns attended SAS/fingerprint display;
  gateway events contain only opaque state transitions and never those comparison fields.
- Strict helper `reset_identity`/`get_reset_status` commands and `IdentityResetReceiptV1`: a reset
  request carries a canonical uint64 tombstone and expected old installation fingerprint; the
  durable receipt binds that tombstone, old/new public identity, cleared credential/pair/role state,
  and completion stage. Same-tombstone recovery is idempotent; lower/mismatched tombstones fail.
- Capability names are namespaced strings. Initial required names are `waifus.http.v1`, `waifus.stream.cancel.v1`, `waifus.sse.cursor.v1`, `waifus.dashboard.manifest.v1`, `waifus.principal.v1`, and `waifus.browser-context.v1`.
- Public pairing byte contracts include the exact `WF1.` canonical-CBOR token/signature, canonical signed identity bundle, both pinned Noise transcript cases, channel binding, pair ID, pair-root derivation and all four V1 domain-separated key derivations, 50-bit SAS indices/words, 12-character fingerprint, identical-host/joiner-installation self-pair rejection, and substitution/rejection vectors. Cloudflare storage and routing implementation remains private, but no security boundary depends on hiding signed wire bytes.
- Public service/endpoint fixtures pin the exact role enum (`host = 1`, `remote = 2`), canonical length-prefixed application-session challenge in host-then-remote order, both transport session IDs, application-session-bound browser-context key/proof and strict fields, `ApprovalReceiptV1` canonical bytes/context hash/expiry/invitation generation, canonical endpoint CBOR, associated-data bytes, AEAD ciphertext, tamper/rollback cases, and 1,184-byte plaintext/1,200-byte ciphertext boundaries. The approval receipt always binds a strict browser-source union: a local approval carries the current 32-byte host-browser-server launch ID and browser session ID; a remote approval carries the exact helper-verified 32-byte remote gateway launch ID and browser session ID. Both bind the confirmation request nonce/method/canonical concrete target; assistant provenance may augment but never replace those browser bindings.
- The three named control goldens are public cross-repository authorities, not private helper or
  Worker-local fixtures:
  - `contracts/remote/v1/fixtures/crypto/http-auth-envelope-v1.json` pins ordered raw headers,
    canonical certificate/request/response bytes, concrete path signing, WebSocket upgrade/101,
    limits, duplicates, replay, and every valid/invalid request class.
  - `contracts/remote/v1/fixtures/crypto/pair-control-record-v1.json` pins all nine strict record
    types, signature preimages, payload hashes, high-water/idempotency behavior, revocation MAC
    contexts, delayed-poll timestamp semantics, and the closed transport matrix:
    WebSocket accepts types `1–9`; ordinary HTTPS publish accepts only `1–6,9`; dedicated revoke
    accepts only `7`; dedicated revocation acknowledgement accepts only `8`; HTTPS poll returns at
    most one retained type `1–9` above the authenticated cursor. A record must pass the ±60-second
    timestamp check at first Worker ingress; a helper later receiving that durably accepted record
    does not reject it solely because offline polling made it old, while presence still expires by
    its signed validity.
  - `contracts/remote/v1/fixtures/crypto/pair-confirmation-v1.json` pins the exact
    `PairConfirmationV1` canonical bytes/MAC, post-approval `pair_confirmation` mailbox phase,
    publish-local-then-poll-and-verify-peer-then-consume ordering, duplicate/idempotent behavior,
    1,024/1,025-byte boundary, both roles, and every transcript/pair/context substitution.
- Public activation/control fixtures pin the exact canonical-CBOR unsigned and signed activation certificate, Worker key ID, domain-separated Ed25519 input, ordinary certificate-authenticated request, pre-certificate activation begin/poll requests, and signed success/error responses. Fixtures substitute every method/path/body/protocol/key/certificate/nonce field and prove noncanonical, replayed, or cross-context bytes fail.
- `helper-manifest.schema.json` is the public cross-repository authority used before plan 06's verifier exists and before plan 07's private packager emits artifacts. It includes exact target/build/source/contract/fork fields, protocol and capability ranges, canonical uint64 release sequence, signed canonical `releasedAt`, binary/notices hashes, release-key IDs, `workerTrustRingSha256` over the canonical private helper `WORKER_KEYS.lock`, and both minimum and maximum-exclusive compatible Discord Waifus versions. The private repository consumes this schema; it does not redefine it. Trust fixtures evaluate key sequence/time windows against the signed manifest values, not current wall-clock expiry.
- The public WIPC contract specifies mutual `parentProof`/`helperProof`, strictly monotonic per-side stream-ID parity/high-water behavior, the full request/response/cancel terminal state machine, initial per-direction credit, exact `WINDOW_UPDATE` payload/accounting, overflow/late/duplicate rejection, exhaustion-before-wrap, and boundary vectors. Local aggregate queue/backoff/timeouts remain explicitly identified as implementation policy rather than wire semantics.
- A Noise mailbox message is at most 1,200 decoded bytes. Fixtures include the maximum-width unpadded-base64url typed JSON control record and prove it remains within the Worker's immutable 2,048-byte raw-record cap; 1,201 decoded bytes fails before transport.
- `contracts/wordlists/sas-v1.txt` is an immutable v1 protocol artifact: exactly 1,024 unique lowercase ASCII words, one LF-terminated word per line, with documented provenance/license, ambiguity review rules, and SHA-256. Reordering or replacing a word requires a pairing-protocol major change.

- [ ] **Step 1: Write failing schema and fixture tests.** Test valid round trips, unknown required capabilities, unknown fields, malformed fingerprints, over-limit values, protocol-major mismatch, optional-minor negotiation, downgrade rejection, and secret-bearing status/diagnostic fixture rejection. Pin exact `parentProof`/`helperProof` bytes and reject a wrong helper proof, reflected parent proof, replayed hello, second client, and socket-race impersonator before any command/event/stream. Add public byte fixtures for canonical/noncanonical CBOR, full-token signature/fingerprint/expiry, signed identity bundles, `Noise_XXpsk0_25519_ChaChaPoly_SHA256`, `Noise_XX_25519_ChaChaPoly_SHA256`, pair-root/four-key derivations, application-session browser-context proof, activation certificate and signed request/response envelopes, transcript or field substitution, the 1,200/1,201-byte mailbox boundary, and deterministic SAS output. Browser-context negatives substitute gateway launch/session, device/epoch, direct session/stream, request nonce, method/target, and CSRF result and prove a header-only/dashboard/assistant caller cannot create a valid principal context.
  For every uint64 JSON field, include `MAX_SAFE_INTEGER + 1` and uint64 max canonical strings and
  reject number coercion, overflow, exponent, sign, whitespace, and leading-zero variants.
  Add reset command/receipt vectors for first execution, same-tombstone recovery after every helper
  journal stage, stale/mismatched tombstone, wrong old fingerprint, and private-state corruption.

- [ ] **Step 2: Run the tests and prove the contracts do not exist yet.**

  Run: `npx vitest run tests/remoteProtocolSchemas.test.ts tests/remoteAccessSchemas.test.ts tests/remotePairingVectors.test.ts`

  Expected: FAIL because the schema modules and committed contract bundle do not exist.

- [ ] **Step 3: Implement the TypeScript schemas and derive committed JSON Schemas/fixtures from the same definitions.** Do not hand-maintain two subtly different authorities. Add a deterministic generator script only if the current Zod toolchain cannot emit the files directly; generated output must be stable byte-for-byte. Document exactly which crypto-vector fields are generated by the pinned Go Noise implementation and which are independently checked by Node. The helper-manifest schema/goldens land here before either the public resolver or private packager task begins.

- [ ] **Step 4: Add a reproducible public Go vector/conformance harness.** Pin Go 1.26.5 and `github.com/flynn/noise` v1.1.0/commit `4d9f71cd4ba1fe81415efac312664ccc4bc79b46` in the nested module. `generate-vectors --check` recreates or independently verifies WIPC mutual-auth/flow-control/high-water state, reset command/receipt recovery, both Noise handshakes, pair-root/four-key derivation, app-session transcript/browser-context proof, token/bundle/approval receipt, activation/control signatures, SAS, endpoint CBOR/AD/AEAD, and boundary fixtures without private Worker implementation code. Go and TypeScript must both accept every valid fixture and reject every invalid one.

- [ ] **Step 5: Add the fixture, manifest, and wordlist audits.** Fail if a valid fixture is rejected, an invalid fixture is accepted, a JSON Schema differs from regenerated output, or a contract field lacks a size/count bound. For `sas-v1.txt`, require exactly 1,024 LF-terminated lowercase ASCII entries, uniqueness, the checked-in ambiguity-denylist/manual-review rules, documented licensing/provenance, the frozen SHA-256, and SAS fixtures pinning all five indices and words. Require maximum-width encoded Noise/endpoint control records to stay at or below 2,048 raw bytes without increasing that limit. Audit helper-manifest target/version/range/signature/downgrade fixtures in both languages, including missing/malformed/wrong `workerTrustRingSha256` and embedded build-info mismatch.

- [ ] **Step 6: Run the contract gate.**

  Run:

  ```bash
  npx vitest run tests/remoteProtocolSchemas.test.ts tests/remoteAccessSchemas.test.ts tests/remotePairingVectors.test.ts
  go -C contracts/remote/v1/conformance-go test ./...
  go -C contracts/remote/v1/conformance-go run ./cmd/generate-vectors --check
  npm run typecheck
  ```

  Expected: PASS; regenerated contract files produce no diff and the two languages agree byte-for-byte.

- [ ] **Step 7: Hand the exact public commit SHA, wordlist hash, schemas, and fixtures to the private helper lock.** Production IPC/pairing/packaging remains blocked until the private helper records that commit and re-runs the same WIPC auth/flow-control/high-water, manifest, token/identity, Noise, pair-root/four-key, app-session/browser-context, approval-receipt, activation/control, endpoint, mailbox-limit, and SAS conformance vectors byte-for-byte.

**Suggested commit:** `feat: lock remote management contracts`

---

### Task 2: Add principals, internal dispatch, route policies, and browser security

**Files:**

- Create: `src/api/requestPrincipal.ts`
- Create: `src/api/internalDispatch.ts`
- Create: `src/api/routePolicy.ts`
- Create: `src/api/routePolicyManifest.ts`
- Create: `src/api/browserSecurity.ts`
- Create: `src/api/fastify.d.ts`
- Modify: `src/api/server.ts:createApiServer`, every `app.get/put/post/delete`, gateway registration, static fallback
- Modify: `src/api/assistant/routes.ts:registerAssistantRoutes`
- Modify: `src/api/assistant/service.ts:getJson`, `resolveAssistantTarget`, `buildSnapshot`, `runAssistantTurn`
- Modify: `src/api/assistant/tools.ts:AssistantToolContext`, `inject`, `revisionedPut`
- Modify: `src/backend/server.ts:startBackend`
- Modify: `src/shared/schemas/config.ts` with a truly optional `UpdateAppConfigBodySchema`
- Modify: `src/config/appConfig.ts` with merge-before-validate save semantics
- Modify: `package.json`, `package-lock.json` only if `@fastify/cookie` is selected
- Test: `tests/requestPrincipal.test.ts`
- Test: `tests/routePolicy.test.ts`
- Test: `tests/browserSecurity.test.ts`
- Test: existing assistant API/tool suites

**Principal model:**

```ts
type RequestPrincipal =
  | {
      kind: "local";
      stableId: "local";
      browserContext?: {
        verifiedBy: "host_server";
        hostServerLaunchId: string;
        browserSessionId: string;
        requestNonce: string;
        method: string;
        canonicalTarget: string;
        csrfValidated: boolean;
      };
    }
  | {
      kind: "remote_device";
      stableId: string;
      deviceId: string;
      peerFingerprint: string;
      transportSessionId: string;
      trustEpoch: Uint64Decimal;
      browserContext?: {
        verifiedBy: "host_helper";
        gatewayLaunchId: string;
        browserSessionId: string;
        requestNonce: string;
        method: string;
        canonicalTarget: string;
        csrfValidated: boolean;
      };
    };

type AssistantDelegation = {
  conversationId: string;
  toolCallId?: string;
  pendingActionId?: string;
};
```

Delegation augments the initiating actor; it never replaces it.

`Uint64Decimal` is the branded canonical string at JavaScript/JSON boundaries. Code that increments
or compares it converts to `bigint` and converts back with base-10 `toString()`. Tests include
`9007199254740992` (`MAX_SAFE_INTEGER + 1`) and `18446744073709551615`, plus rejection of the same
values as JSON numbers, overflow, negative, exponent, whitespace, plus-sign, and leading-zero forms.

**Policy model:** every registered route declares `remotePolicy`, and every non-safe method also declares `retryClass` and `auditAction`. Mixed-sensitivity routes declare a field policy. Automatic HEAD routes inherit their GET policy; no other implicit route is exempt.

- `full_admin`: all deliberately supported current API routes, including provider credentials, Discord bots, logs, histories, assistant routes, the reviewed semantic LLM gateway routes listed below, runtime control, diagnostics, and events.
- `local_only`: host identity reset and future host network/filesystem exposure controls.
- `never_proxy`: `GET /api/client-context`; the remote gateway must intercept it. Gateway-owned `/_waifus_remote/v1/*` routes never register on the host at all.
- `GET/PUT /api/config` is `full_admin` with a field policy that redacts or rejects `http.host`, `frontend.staticDir`, absolute data-root values, and future equivalent exposure fields for `remote_device`. Change PUT parsing to a true partial patch merged over stored configuration before `AppConfigSchema` validation; omitted/redacted fields must never let Zod defaults overwrite local-only values.
- The `@waifucave/gateway` wildcard is not itself a blanket remote grant. A `remote_device` may reach only `GET /api/llm/v1/providers`, `GET /api/llm/v1/models`, `GET /api/llm/v1/models/:provider/:model`, `POST /api/llm/v1/chat`, and `POST /api/llm/v1/validate`. Every other present or future gateway method/path fails closed until it is added to both the reviewed inner allowlist and the route-policy inventory.
- Host dashboard bytes are not covered by a generic catch-all permission. Later remote asset downloads must pass the manifest allowlist in `05-host-api-and-bridge.md`.

- [ ] **Step 1: Write failing principal tests.** Cover ordinary loopback local calls, explicit internal dispatch, missing actor on production internal dispatch, forged `X-Device-*`/internal-capability headers, stale trust epochs, revoked devices, assistant delegation inheritance, and concurrent actor isolation.

- [ ] **Step 2: Write the failing route-inventory test.** Capture Fastify `onRoute` registrations and compare method/route templates with `routePolicyManifest.ts`. Include the `@waifucave/gateway` wildcard plus its five-entry remote semantic allowlist, assistant routes, root/static handling, automatic HEAD, and the not-found API behavior. Add a test-only unclassified route and an unknown gateway subroute and prove both are remotely denied; the unclassified Fastify route must also fail startup/test validation.

- [ ] **Step 3: Write failing browser-security and config-field tests.** Cover exact Host, exact Origin, DNS-rebinding hostnames, cross-site `Sec-Fetch-Site`, missing/wrong CSRF on unsafe browser methods, 32-byte host-server launch ID plus cookie rotation/expiry, stale launch/session rejection after restart, valid loopback command-line automation without Origin, and the two explicit Vite dev origins only in dev mode. Seed nondefault `http.host`/`frontend.staticDir`, send a remote partial config PUT omitting them, and prove they remain byte-identical; explicitly supplying either remotely must be rejected.

- [ ] **Step 4: Run the focused tests.**

  Run: `npx vitest run tests/requestPrincipal.test.ts tests/routePolicy.test.ts tests/browserSecurity.test.ts`

  Expected: FAIL because current Fastify requests have no principal, route metadata, browser session, or CSRF enforcement.

- [ ] **Step 5: Implement `AsyncLocalStorage`-backed internal dispatch for in-process callers.** `dispatchInternal(actor, delegation?, injectOptions)` is the only production path for assistant self-REST. Remove all raw production `app.inject` calls. An absent internal actor is an error, never an implicit local administrator. Do not use an HTTP header to carry the actor.

- [ ] **Step 6: Install Fastify hooks.** Derive `local` only from the actual loopback listener boundary; strip/reject every client-supplied internal-principal field; attach route metadata; authorize before body-side effects; recheck remote trust on every request.

- [ ] **Step 7: Apply exact browser rules.** Non-browser loopback automation remains compatible.
  Browser unsafe methods require the session cookie and `X-Waifus-CSRF`. After validation, attach
  immutable current host-server launch/session, a fresh 16-byte server-generated request nonce,
  method, canonical concrete target, and CSRF result to the local browser context; never accept
  those as client principal headers. Encode the 32-byte CSRF token as exactly 43-character
  canonical unpadded base64url and return it only in the `X-Waifus-CSRF` response header on the
  same-origin, credentialed, `Cache-Control: no-store` `GET /api/client-context`; its body retains
  the strict client-context DTO. Set/refresh the host-only HttpOnly session cookie before that
  response. Reject CORS/cross-site reads, never expose the header on a host-proxied response, and
  never put the token in HTML, a URL, browser storage, logs, or diagnostics.

- [ ] **Step 8: Classify the entire current route surface and make app-config PUT patch-safe.** Wrap gateway registration so its wildcard receives reviewed metadata and enforces the exact five-route inner allowlist for `remote_device`; unknown methods or paths remain denied even if the package adds them later. Replace the implicit SPA catch-all with an explicitly reviewed static route/fallback without allowing `/api/*` to become frontend HTML. Implement `UpdateAppConfigBodySchema` without manufactured defaults, reject remote restricted fields before merging, then validate and save the complete merged config.

- [ ] **Step 9: Run focused and regression tests.**

  Run: `npx vitest run tests/requestPrincipal.test.ts tests/routePolicy.test.ts tests/browserSecurity.test.ts tests/api.test.ts tests/assistantApi.test.ts tests/assistantTools.test.ts`

  Expected: PASS; adding a route without policy fails deterministically.

**Suggested commit:** `feat: enforce request principals and route policies`

---

### Task 3: Remove current secret leaks and add principal-aware response redaction

**Files:**

- Modify: `src/storage/errors.ts:StorageConflictError`
- Modify: `src/api/server.ts:setErrorHandler`, `/api/status`, `/api/runtime`, `/api/config`, `/api/logs`, `/api/diagnostics/bundle`, `/api/events`
- Modify: `src/api/errors.ts`
- Modify: `src/backend/redaction.ts:redactSecrets`
- Modify: `src/shared/queryLog.ts`
- Modify: `src/frontend/api/types.ts:ApiErrorBody` only to narrow the conflict metadata contract
- Test: `tests/apiRedaction.test.ts`
- Modify tests: `tests/api.test.ts`, `tests/logsEndpoint.test.ts`

**Required conflict DTO:**

```json
{
  "error": "Conflict",
  "message": "Record has changed since it was read.",
  "latest": {
    "schemaVersion": 2,
    "revision": 1,
    "updatedAt": "..."
  }
}
```

The server must never serialize `StorageConflictError.latest` directly. This is a release blocker because stale provider and Discord-bot writes currently expose stored `apiKey`/`token` fields through the generic error handler.

- [ ] **Step 1: Write redaction goldens before changing production code.** Cause stale provider-credential and Discord-bot writes using sentinel secrets. Assert the full status, headers, body, logs, diagnostics, audit stub, and events contain none of them. Add endpoint-candidate, invitation-secret, internal-capability, Authorization, and private-key sentinels.

- [ ] **Step 2: Add remote-principal response tests.** Remote `/api/config` must omit/reject restricted fields; remote status/runtime/diagnostics must not expose `dataRoot`, host-local URL, absolute paths, endpoint plaintext, or helper IPC paths. Local responses preserve existing intended behavior.

- [ ] **Step 3: Run and observe the credential-conflict failure.**

  Run: `npx vitest run tests/apiRedaction.test.ts tests/api.test.ts -t "redact|credential|discord-bots"`

  Expected: FAIL because `createApiServer` currently returns raw `error.latest`.

- [ ] **Step 4: Implement the redacted conflict-version helper and apply it in the global error handler.** Existing frontend retry code does a fresh GET and requires only the revision; do not return resource-specific stored state.

- [ ] **Step 5: Centralize final serialization redaction.** Extend `redactSecrets` for the forbidden classes, but use explicit status/config/diagnostic DTO builders rather than regex redaction for host-only fields. Preserve deliberately authorized prompt/query/reply visibility while scrubbing secret material.

- [ ] **Step 6: Ensure sensitive responses carry `Cache-Control: no-store` and that error logging passes through redaction before writing message/context/stack.** Zod issue serialization must not echo sensitive input.

- [ ] **Step 7: Run focused and API suites.**

  Run: `npx vitest run tests/apiRedaction.test.ts tests/api.test.ts tests/logsEndpoint.test.ts tests/llmGatewayCredentials.test.ts`

  Expected: PASS with no sentinel secret in captured output.

**Suggested commit:** `fix: redact conflicts and remote API responses`

---

### Task 4: Add durable operation, retry, and administrative-audit primitives

**Files:**

- Create: `src/shared/schemas/adminOperations.ts`
- Create: `src/storage/operationStore.ts`
- Create: `src/storage/auditStore.ts`
- Create: `src/api/mutations.ts`
- Create: `src/api/adminOperations.ts`
- Modify: `src/storage/storageService.ts`
- Modify: `src/api/server.ts` mutation registrations/handlers
- Modify: `src/api/assistant/routes.ts`
- Test: `tests/operationStore.test.ts`
- Test: `tests/adminOperationsApi.test.ts`
- Test: `tests/auditStore.test.ts`
- Test: `tests/mutationPolicy.test.ts`

**Retry classification lock for the current surface:**

| Class | Existing routes |
|---|---|
| `transactional` | Agent-config writes; provider credential PUT/DELETE; waifu CRUD and asset writes; server/channel CRUD; memory CRUD; assistant-action cancellation. |
| `reconciled` | App config plus reload; Discord-bot write plus reload; OCR clear; waifu `link-bot`; member/emoji/role refresh; runtime pause/resume/reload/stop. |
| `non_replayable` | Persona digest; runtime orchestrator/stage-manager trigger; `/api/llm/v1/chat`; assistant message turn until durable turn recovery exists. |
| `invitation_recovery` | Remote invitation creation only; implemented with helper-held creator-bound secret state in the host API plan. |
| `safe` | GET/HEAD and `/api/llm/v1/validate`. |

No route is automatically retried merely because it uses POST or returned no response before disconnect.

Every long-running/reconciled `202` response is the strict
`{operationId, status, statusUrl}` DTO, where `statusUrl` is the canonical same-origin
`/api/admin/operations/:operationId` path. `GET` on that path is a `full_admin`, safe-read,
`no-store` route, but a remote can read only an operation created by that same stable actor at the
same trust epoch; a local principal may read any operation in its data root. Missing, expired, or
unauthorized IDs all return the same `404`, and every representation/result is field-redacted.
This addressable resource—not delivery of an SSE event—is the recovery authority after disconnect.

- [ ] **Step 1: Write failing operation-store and status-route tests.** Cover first reservation,
  same-key/same-concrete-target/body completed replay, same key/body against a different path
  parameter or mutation-semantic query producing an independent lookup identity, and the same
  concrete target/key with a changed body fingerprint producing `409`; also cover actor/trust-epoch
  isolation, prepared-record restart, bounded result storage, TTL-expired cleanup, and corrupt-record
  fail-closed behavior. Pin the exact `202` DTO and same-actor/local-only visibility rules for
  `GET /api/admin/operations/:operationId`; reconnect by ID must return the same redacted completed/
  reconciled/unknown state, while cross-device, stale-epoch, expired, and random IDs are
  indistinguishable `404` with `no-store`. Fill both count and byte caps entirely with unexpired
  completed/prepared/unknown receipts and prove none is evicted and the next mutation fails closed;
  after expiry, prove deterministic oldest-expired cleanup permits progress.

- [ ] **Step 2: Write failing audit tests.** Cover accepted, completed, rejected, conflict, reconciled, and unknown outcomes; actor and assistant delegation; before/after revisions; retention; concurrent writers; mode `0600`; and a forbidden-key/value corpus.

- [ ] **Step 3: Run focused tests.**

  Run: `npx vitest run tests/operationStore.test.ts tests/adminOperationsApi.test.ts tests/auditStore.test.ts tests/mutationPolicy.test.ts`

  Expected: FAIL because no operation or audit primitives exist.

- [ ] **Step 4: Implement write-ahead operation handling.** Persist `prepared` before the handler. Persist a redacted `completed` receipt after the local effect. A prepared record found after uncertainty returns `outcome_unknown` unless that route supplies a deterministic reconciler. Never infer success from a separate ledger write or repeat an unresolved effect. Prune only expired records; if no expired record can free required count/bytes, reject before executing the mutation.

- [ ] **Step 5: Implement the administrative audit store independently of ordinary removable logs.** Store actor type/device, local/remote origin, delegation IDs, action/resource, request/idempotency ID, before/after revision, outcome, and timestamp. Store neither raw bodies nor secret-bearing results.

- [ ] **Step 6: Require remote unsafe requests to carry a valid idempotency key.** Local callers remain backward compatible but still receive a generated request ID and audit event. Hash canonical parsed JSON; hash raw/binary request bytes while streaming without logging them.

- [ ] **Step 7: Wrap every existing mutation and make the inventory test fail if a non-safe route lacks retry/audit metadata.** Long-running/external routes create/reconcile addressable operation resources and return their status URL. Register and classify the principal-scoped status route. `non_replayable` routes never automatically repeat after an uncertain outcome.

- [ ] **Step 8: Run operation, API, assistant, and storage regressions.**

  Run: `npx vitest run tests/operationStore.test.ts tests/adminOperationsApi.test.ts tests/auditStore.test.ts tests/mutationPolicy.test.ts tests/storage.test.ts tests/api.test.ts tests/assistantApi.test.ts tests/assistantTools.test.ts`

  Expected: PASS; killing between prepared/effect/completed produces a durable unknown result rather than a duplicate effect.

**Suggested commit:** `feat: add durable admin operations and audit`

---

### Task 5: Replace process-local SSE behavior with epoch-aware authorized streams

**Files:**

- Create: `src/api/eventStream.ts`
- Modify: `src/api/server.ts:sendSseSnapshot`, `/api/events`
- Modify: `src/api/assistant/conversations.ts:AssistantEvent`, event sequence/listener storage
- Modify: `src/api/assistant/routes.ts` stream route
- Modify: `src/shared/queryLog.ts`
- Create: `src/frontend/api/eventCursor.ts`
- Create: `src/frontend/api/resumableEventFeed.ts`
- Modify: `src/frontend/api/client.ts`
- Modify: `src/frontend/state/assistantChat.ts`
- Test: `tests/eventStream.test.ts`
- Test: `tests/eventsApi.test.ts`
- Test: `tests/frontendEventCursor.test.ts`
- Modify tests: `tests/assistantConversations.test.ts`, `tests/assistantApi.test.ts`

- [ ] **Step 1: Write failing generic stream and current-consumer tests.** Cover exact 128-bit epoch generation and `v1:<base64url-unpadded epoch>:<decimal seq>` parsing, monotonic cursor creation, replay from `Last-Event-ID`, duplicate suppression, epoch mismatch, cursor gap, canonical snapshot, eviction at 2,000 events or 8 MiB, event-size rejection, cancellation cleanup, and heartbeat authorization recheck. Freeze a same-origin credentialed `fetch` streaming SSE transport with `AbortController`, incremental UTF-8/event parsing, and an explicit `Last-Event-ID` request header; native `EventSource` is not the resumable primitive because callers cannot set that header themselves. Prove the current assistant frontend no longer calls `Number(lastEventId)`, deduplicates within one epoch, aborts/reconnects without listener leaks, and performs snapshot/reset behavior on an epoch change or gap. Plan 06 later extends the same primitive to every remaining feed.

- [ ] **Step 2: Write API-level redaction and revocation tests.** A remote sees authorized runtime/log/query/reply events, never secrets or host-only paths. Revocation closes `/api/events`, assistant SSE, and future remote-access SSE without one more protected event.

- [ ] **Step 3: Run and prove current streams fail.**

  Run: `npx vitest run tests/eventStream.test.ts tests/eventsApi.test.ts tests/frontendEventCursor.test.ts tests/assistantConversations.test.ts tests/assistantApi.test.ts`

  Expected: FAIL because current `/api/events` has no IDs/replay epoch and assistant uses only a process-local integer.

- [ ] **Step 4: Implement `EventStream<T>`.** Serialize through principal-aware redaction, capture the principal at subscription, revalidate trust on every event and heartbeat, and emit an explicit `snapshot_required` event before a canonical snapshot when epoch/cursor recovery is impossible.

- [ ] **Step 5: Migrate global and assistant streams plus the current assistant frontend consumer atomically.** Preserve current event names where compatible. Add the typed `confirmation_required` assistant event now so later secure-action work does not create a second incompatible stream change. Commit the shared exact cursor parser and fetch-based resumable feed with this backend change so no released dashboard attempts to coerce `v1:...` to a number or assumes a custom-header-capable `EventSource` API.

- [ ] **Step 6: Run focused and frontend type checks.**

  Run: `npx vitest run tests/eventStream.test.ts tests/eventsApi.test.ts tests/frontendEventCursor.test.ts tests/assistantConversations.test.ts tests/assistantApi.test.ts && npm run typecheck`

  Expected: PASS; reconnection either replays a bounded authorized suffix or forces a snapshot.

**Suggested commit:** `feat: add authorized epoch-aware event streams`

---

### Task 6: Partition persistent remote state and make clean/reset semantics explicit

**Files:**

- Modify: `src/config/layout.ts:DATA_LAYOUT_DIRS`, `ensureDataLayout`
- Modify: `src/backend/migrations.ts:runMigrations`
- Modify: `src/cli/commands.ts:cleanCommand`
- Modify: `src/backend/runtime.ts:RuntimeStateSchema`
- Modify: `src/shared/schemas/remoteAccess.ts`
- Test: `tests/config.test.ts`
- Test: `tests/migrations.test.ts`
- Modify tests: `tests/cli.test.ts`, `tests/backend.test.ts`

**Path ownership lock:**

| Path | Content | `waifus clean` |
|---|---|---|
| `app/remote-access/config.json` | Revisioned host enabled/display settings | Preserve unchanged |
| `app/remote-access/installation.json` | Nonsecret OS-vault label/install ID and activation reference | Preserve |
| `app/remote-access/trust/` | Pinned public bundles, pair metadata, local deny state, trust epochs | Preserve |
| `app/remote-access/operations/` | Bounded operation receipts | Preserve until TTL |
| `app/remote-access/audit/` | Administrative security audit | Preserve even with ordinary log cleanup |
| `app/remote-gateway/` | Remembered host/origin state and nonsecret remote-role vault references | Preserve |
| `app/cache/remote-dashboard/` | Verified host/build assets | Delete |
| `app/tmp/remote-host/`, `app/tmp/remote-gateway/` | Live PID/socket/lock/runtime files | Delete after running-daemon refusal |
| `app/logs/remote-host.log`, `app/logs/remote-gateway.log` | Ordinary helper/app diagnostics | Preserve normally; delete with `--include-logs` |

Private keys remain helper-owned in OS storage. No private key is written to these paths.

- [ ] **Step 1: Write failing layout/migration tests.** Cover a fresh root, an existing root, two different `DC_WAIFUS_HOME` values, mode `0600`, invalid state, and idempotent migration.

- [ ] **Step 2: Write failing clean tests.** Seed running/stopped host and remote daemon states plus identity, activation, trust, remembered-host, bounded operation receipts, audit, enabled/settings, ordinary config, cache, transient role-runtime, ordinary role-log, and audit-log sentinels. Assert clean refuses without mutation while either daemon runs. Once both are stopped, assert every preserved remote sentinel—including enabled/settings and operation receipts—is byte-identical, dashboard cache, transient runtime, and ordinary user/config/cache data are gone, ordinary role logs follow `--include-logs`, administrative audit is never treated as an ordinary log, and output reports the preserved pairing count plus the explicit local Settings → Remote Access reset instruction.

- [ ] **Step 3: Run focused tests.**

  Run: `npx vitest run tests/config.test.ts tests/migrations.test.ts tests/cli.test.ts -t "remote|clean|identity|pair"`

  Expected: FAIL because current `cleanCommand` removes all `user/`, config, and app cache without remote-aware reporting/state.

- [ ] **Step 4: Add the directories/default remote settings and migration under `app/remote-access/`.** Do not rotate or recreate an existing installation ID merely because app schema or package version changes. Keep trust epochs monotonic.

- [ ] **Step 5: Update `cleanCommand`.** Refuse while either daemon is live. Once stopped, clear ordinary user/config/cache data, exact transient role-runtime paths, and remote dashboard cache while preserving remote settings/enabled state, activation, trust, identity, deny epochs, remembered hosts, bounded operation receipts, and audit byte-for-byte. Preserve ordinary host/remote logs unless `--include-logs`; even that flag never removes administrative audit. Print the preserved pair count and an explicit instruction to use the typed identity reset in local Settings → Remote Access, backed by local-only `POST /api/remote-access/reset`. That API is the only full-installation identity rotation/all-pair reset path; reviewed per-device revoke and remote-side forget still remove individual trust relationships.

- [ ] **Step 6: Freeze reset path ownership without implementing helper rotation here.** The later
  reset must disable host remote access, clear activation and both roles' vault key references,
  trusted pairs, remembered hosts, local-origin seed/epochs/high-water, and dashboard cache. It must
  retain operation receipts/audit and a monotonic reset tombstone. Document that the current host
  daemon is the executor, while a separately live remote gateway/helper produces typed
  `SiblingDaemonRunning`; deleting one role's files while the sibling is active is forbidden.

- [ ] **Step 7: Extend runtime state with a sanitized optional `remoteAccess` summary.** Runtime files may contain local paths for local CLI use, but remote API serialization must use the Task 3 DTO rather than returning the file verbatim.

- [ ] **Step 8: Run the baseline completion gate.**

  Run: `npm run test && npm run typecheck && npm run build`

  Expected: PASS. No remote helper is launched and no new non-loopback listener exists.

**Suggested commit:** `feat: persist remote trust across clean operations`

## Completion gate

Do not start the host bridge plan until all of the following are true:

- Public schemas and fixtures are stable and shared with the Go conformance harness.
- Every current Fastify route is inventoried and classified.
- Provider/Discord conflict responses and all remote status surfaces pass redaction goldens.
- Forged principal headers, stale/revoked actors, cross-origin browsers, and missing CSRF are rejected.
- Every unsafe route has a retry/audit class, with unknown outcomes never replayed.
- Global and assistant streams use epoch-aware authorization-filtered cursors.
- Clean refuses with either daemon live and otherwise preserves identity, activation, trust, remote enabled/settings state, deny epochs, remembered hosts, bounded operation receipts, and audit while deleting dashboard caches.
- `npm run test`, `npm run typecheck`, and `npm run build` pass.
