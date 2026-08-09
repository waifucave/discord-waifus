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

`generate-vectors --check` builds `fixtures/crypto/wipc-v1.json` independently with Go and compares
the exact compact canonical JSON bytes to the TypeScript-generated public fixture. The current
slice covers the WIPC header, payload classes, window-update encoding, per-side stream-ID
high-water/exhaustion rules, and parent/helper HMAC transcript. Later slices extend this same gate
with the full stream state machine, Noise transcripts, key derivations, signed envelopes, endpoint
encryption, SAS, and remaining boundary fixtures.
