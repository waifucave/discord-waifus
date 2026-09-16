# Remote Access

Remote Access lets a remembered device open the host's exact bundled dashboard and use the same
local API through an authenticated direct peer connection. `pair.waifucave.com` handles only
bounded activation, pairing, presence, endpoint, capability, and revocation metadata. Dashboard,
API, assistant, upload, download, and event-stream bytes are never relayed through Cloudflare or a
WaifuCave server. If the two devices cannot establish a direct path, the connection fails.

## Lifecycle

1. Activate Remote Access from the host's bound local dashboard.
2. Enable it in Settings -> Remote Access.
3. Create a short-lived invitation using the secure dashboard card.
4. On the other device, run `waifus remote`, enter or scan the invitation, and compare the safety
   phrase on both devices before the host approves it.
5. The remote downloads the host-pinned dashboard build, so UI and API capabilities match the host
   even when the installed CLI versions differ. Protocol negotiation still rejects an incompatible
   helper instead of guessing.

Pairing tokens, QR payloads, safety words, fingerprints, transcript bindings, endpoint metadata,
and private keys must stay out of assistant chat, logs, diagnostics, and screenshots. The secure
dashboard surfaces are the only place to inspect or confirm them.

## Assistant tools

The assistant can read status and sanitized diagnostics, enable or disable access, request or
cancel an invitation, list and decide pending pairings, list or rename trusted devices, request a
device revocation, and trigger direct reconnection. Trust-expanding or trust-removing operations use
server-held confirmation cards; the model cannot confirm its own proposal or replace the stored
target. A remote assistant call remains attributed to its paired device and browser session.

Full installation identity reset is intentionally not an assistant tool. It is available only from
the host's bound local Settings -> Remote Access page, requires the exact typed confirmation, and
removes every pairing before requiring activation again.

## Revocation and recovery

Always list devices immediately before rename or revoke and use the returned `revision`. A mismatch
returns a conflict so the caller can review the current device again.

Revocation first writes a host-local deny cutoff. From that point, the old device epoch cannot open
new requests, consume pending assistant actions, or resume conversations—even during helper or
coordination failure. After the accepted response reaches the caller, the host closes only that
device's active streams and tells the helper to persist and converge the cryptographic revocation.
An interrupted convergence resumes on helper reconnect or host restart. Re-pairing requires a new
pair identity and a trust epoch above the deny cutoff; changing only the old epoch cannot resurrect
the revoked pair.

## Troubleshooting

- `direct_unavailable` or `reconnecting`: use the reconnect action after checking that both devices
  have working UDP connectivity. Network/interface changes are rediscovered automatically.
- `activation_required`: complete activation from the host's local dashboard first.
- `helper_missing`, `helper_signature_invalid`, or `helper_incompatible`: install a verified helper
  build for the current platform; do not bypass signature or compatibility checks.
- Hard NAT or blocked UDP: there is intentionally no relay fallback.

The V1 target matrix excludes Intel macOS. Intel macOS support is a later follow-up.
