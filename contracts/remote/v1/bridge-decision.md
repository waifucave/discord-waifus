# WIPC V1 host request bridge decision

Date: 2026-08-30

Status: accepted feasibility decision; production helper supervision and frame pumping remain Plan 05 Task 2 work.

## Decision

Use the streaming-capable Fastify internal adapter permitted by Plan 05 Task 1. The host keeps one
Fastify route, policy, validation, mutation, audit, and error boundary. A mutually authenticated
`ts-connect` parent connection supplies immutable request metadata outside HTTP headers, and the
adapter invokes that same boundary with `payloadAsStream: true`.

This is not the buffered assistant self-REST path. `dispatchInternalStreaming()` resolves when
Fastify writes response headers and exposes the later body as a backpressured Node `Readable`.
Tests deliver an SSE event while the handler remains open, upload 8 MiB incrementally, and download
32 MiB without constructing a whole-response buffer.

## Exact internal API

1. `new RemoteRequestBridge(app)` installs Fastify-close cleanup.
2. `bridge.openAuthenticatedConnection(connectionId, parentAuthentication)` calls
   `WipcParentAuthSession.assertTrafficAllowed()`. No connection opens before the exact mutual
   `parentProof`/`helperProof` exchange succeeds and consumes the one-launch capability.
3. `connection.dispatch({streamId, requestStart, body, signal})` accepts only a positive,
   increasing even parent-WIPC stream ID.
4. `requestStart` is strict V1 data containing only `method`, canonical origin-form target, ordered
   header tuples, and `RequestPrincipalWire`. The trusted adapter converts the wire principal into
   a deeply frozen `remote_device` principal and marks any browser context as
   `verifiedBy: "host_helper"`.
5. `dispatchInternalStreaming(app, principal, undefined, options)` carries that principal in
   `AsyncLocalStorage`, never in a request header. The ordinary loopback listener still derives
   only a local principal.
6. The returned response contains the exact status, safe ordered header tuples, and a streaming
   body. It deliberately has no buffered `body`, `payload`, or JSON convenience contract.

The future `HelperClient` owns WIPC decoding/state transitions and is the only production caller of
`openAuthenticatedConnection`. The test fake performs the same parent/helper proof exchange but
models the already-decoded authenticated request boundary at a high level.

## Header boundary

Request principal, browser context, helper capability, connection identity, and stream identity are
not HTTP headers. Any `X-Device-*` or `X-Waifus-{Principal,Internal,Actor,Browser-Context,Helper}*`
lookalike fails the stream. Hop-by-hop, Host, gateway Cookie/Origin/Fetch Metadata, and gateway CSRF
headers are stripped before Fastify. Repeated safe fields are normalized using ordinary Node HTTP
comma semantics. The encoded retained field block may not exceed 16 KiB.

Response hop-by-hop, helper-internal, `Set-Cookie`, CORS, CSP, Permissions Policy, Referrer Policy,
and service-worker headers are stripped. The remote gateway supplies its own local-origin browser
policies and may rewrite only safe same-host redirects.

## Cancellation path

Cancellation is one chain:

~~~text
remote browser/helper close
  -> per-stream AbortController
  -> upload Readable destroy
  -> internal Fastify abort binding
  -> request aborted/close plus response destroy
  -> SSE cleanup and gateway reply-close observer
  -> provider fetch AbortSignal
  -> response stream close/error
~~~

A response consumer that closes early triggers the same controller. Closing an authenticated helper
connection cancels every stream it owns. Closing Fastify closes the bridge and refuses later streams.
All measured cancellation paths complete inside the locked one-second bound.

If a remote mutation already has a durable reservation when cancellation occurs, its receipt and
audit trail become `outcome_unknown`; it never remains indefinitely `prepared`. The caller retains
the idempotency key and follows the existing reconciliation contract.

## Backpressure and memory bounds

- WIPC decoding rejects data frames above 64 KiB and grants only the frozen 1 MiB directional
  credit window.
- The host admits at most 32 active application streams per device and 128 per authenticated helper
  connection.
- The selected adapter's response `Readable` applies backpressure to `reply.raw.write()`. The spike
  proves a paused 32 MiB producer does not exceed the 2 MiB per-stream policy and that 128 paused
  response streams remain at or below the 8 MiB connection policy.
- Production request bodies must be constructed only from validated WIPC chunks. The Task 2 frame
  pump must stop socket reads/window grants at 2 MiB per stream or 8 MiB aggregate; accepting an
  arbitrary public `Readable` is not a production trust boundary.

## Platform and socket ownership

The adapter opens no listener. `HelperSupervisor` remains responsible for the user-private Unix
socket directory/file modes or the current-user-only Windows named-pipe ACL, capability pipe,
signed helper selection, and process lifecycle. Those platform checks are not replaced by this
in-process dispatch decision.

An Internet client cannot call this API, and an ordinary loopback client cannot forge it: neither
has the OS-protected parent session, a consumed authenticated `WipcParentAuthSession`, or an object
reference to the in-process bridge. Supplying the same strings as HTTP fields is rejected before
route handling.

## Rejected alternatives

- Buffered `app.inject`: fails indefinite SSE, early-event delivery, large-body memory, and useful
  cancellation semantics.
- Loopback HTTP plus a secret or `X-Device-*` actor header: makes remote authority reachable from
  the ordinary browser/loopback surface and is therefore forgeable.
- A second public/non-loopback Fastify listener: violates the loopback-only host boundary and turns
  the dashboard API into a network service.
- A duplicate route stack or framework-neutral router now: would split validation, authorization,
  mutation, audit, assistant, and error behavior without a demonstrated need.
- A second OS-protected HTTP adapter now: remains a fallback only if the selected Fastify/light-my-
  request versions lose the streaming behavior pinned by the spike tests.

## Gate evidence

`tests/remoteRequestBridge.test.ts` covers HTTP/query/header/status parity, immutable principals and
browser context, 8 MiB upload, 32 MiB download, 100-event open SSE, all cancellation paths including
the real `/api/llm/v1/chat` provider fetch, stale trust, forged metadata, stream reuse, 32-device and
128-connection limits, helper disconnect isolation, Fastify shutdown, and ten encoded disconnect
races.

The byte-level companion suites remain authoritative for malformed/oversized WIPC frames, stream
state, exact public proof vectors, reflection/replay, capability erasure, and the socket-race
recovery sequence:

- `tests/wipcProtocol.test.ts`
- `tests/wipcState.test.ts`
- `tests/wipcAuthSession.test.ts`
- `tests/remoteServiceCrypto.test.ts`
