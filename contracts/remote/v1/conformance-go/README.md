# Remote V1 Go conformance

This nested module is an implementation-independent consumer of the public remote-management
contract. It is not the private `ts-connect` helper and contains no Worker implementation,
activation secret, endpoint, or production key.

The module is pinned to Go 1.26.5 and `github.com/flynn/noise` v1.1.0, whose tag resolves to commit
`4d9f71cd4ba1fe81415efac312664ccc4bc79b46`. The committed `go.sum` locks the module content.

From the repository root, run:

```bash
go -C contracts/remote/v1/conformance-go test ./...
go -C contracts/remote/v1/conformance-go run ./cmd/generate-vectors --check
```

`generate-vectors --check` independently builds the three `wipc-*.json` fixtures,
`pairing-v1.json`, `pair-confirmation-v1.json`, `pair-control-record-v1.json`, and
`service-session-v1.json` with Go, then
compares their exact compact canonical JSON bytes to the TypeScript-generated public fixtures. The
current gate covers the WIPC header/state/authentication foundation plus canonical CBOR rejection,
signed full tokens and identities, both pinned Noise XX patterns and channel bindings, contribution
transport, pair-root/four-key derivation, and SAS
indices/fingerprint. It also covers confirmation-key MACs, canonical JSON boundaries, mailbox
ordering, and terminal state. PairControl coverage includes all nine record types, signatures,
transport routing, shared high-water/replay state, delayed delivery, and revocation/ack MACs. Later
slices extend this same gate with the reviewed SAS wordlist, endpoint encryption, activation/control
envelopes, and remaining boundaries. The service-session fixture already covers the direct
four-message authentication gate, session-bound remote-browser proof, replay/state failures, and
both strict approval-receipt sources.
