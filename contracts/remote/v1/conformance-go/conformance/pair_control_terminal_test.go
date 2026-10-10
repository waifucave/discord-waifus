package conformance_test

import (
	"bytes"
	"strconv"
	"testing"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
)

func terminalIngressFixture(t *testing.T) (*pairing.PairControlIngress, func(int, string, string, uint64, byte) []byte) {
	t.Helper()
	seed := bytes.Repeat([]byte{0x51}, 32)
	public, err := pairing.Ed25519Public(seed)
	if err != nil {
		t.Fatal(err)
	}
	pairID := pairing.B64(bytes.Repeat([]byte{0x52}, 16))
	state, err := pairing.NewPairControlIngress(pairID, public, public, nil)
	if err != nil {
		t.Fatal(err)
	}
	record := func(kind int, generation, sequence string, timestamp uint64, nonce byte) []byte {
		t.Helper()
		payload := map[string]any{"revocationEpoch": "2", "revocationMac": pairing.B64(bytes.Repeat([]byte{0x53}, 32))}
		if kind == 7 {
			payload["reason"] = "user_revoked"
		}
		if kind == 1 {
			payload = map[string]any{"resumeConnectionGeneration": "0", "resumeSequence": "0"}
		}
		value, err := pairing.SignPairControlRecord(seed, pairing.PairControlRecord{
			Version: 1, ProtocolMajor: 1, ProtocolMinor: 0, PairID: pairID, Type: kind, Side: 1,
			ConnectionGeneration: generation, Sequence: sequence, Timestamp: strconv.FormatUint(timestamp, 10),
			Nonce: pairing.B64(bytes.Repeat([]byte{nonce}, 16)), Payload: payload,
		}, true)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := pairing.CanonicalPairControlJSON(value)
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	return state, record
}

func TestPairControlReservedTerminalIngressPreservesImmutableSkippedStarts(t *testing.T) {
	for _, kind := range []int{7, 8} {
		for _, prior := range []bool{false, true} {
			t.Run(strconv.Itoa(kind)+"/prior="+strconv.FormatBool(prior), func(t *testing.T) {
				state, record := terminalIngressFixture(t)
				if prior {
					if _, err := state.Accept(record(1, "1", "1", 1000, 0x61), pairing.ControlHTTPSPublish, 1000); err != nil {
						t.Fatal(err)
					}
				}
				transport := pairing.ControlHTTPSRevoke
				if kind == 8 {
					transport = pairing.ControlHTTPSRevokeAck
				}
				payload := record(kind, "3", "2", 1000, 0x62)
				if outcome, err := state.Accept(payload, transport, 1061); err != nil || outcome != "accepted" {
					t.Fatalf("durable skipped start outcome=%s error=%v", outcome, err)
				}
				if outcome, err := state.Accept(payload, transport, 2000); err != nil || outcome != "idempotent" {
					t.Fatalf("exact terminal retry outcome=%s error=%v", outcome, err)
				}
				for _, rejection := range []struct {
					name, generation, sequence string
					timestamp                  uint64
					nonce                      byte
					code                       string
				}{
					{"lower generation", "2", "9", 1061, 0x63, "stale_generation"},
					{"lower sequence", "3", "1", 1061, 0x64, "stale_sequence"},
					{"conflicting tuple", "3", "2", 1061, 0x65, "tuple_conflict"},
					{"nonce replay", "3", "3", 1061, 0x62, "nonce_reused"},
					{"future timestamp", "4", "4", 1122, 0x66, "timestamp_in_future"},
				} {
					if _, err := state.Accept(record(kind, rejection.generation, rejection.sequence, rejection.timestamp, rejection.nonce), transport, 1061); err == nil || controlErrorCode(t, err) != rejection.code {
						t.Fatalf("%s error=%v", rejection.name, err)
					}
				}
			})
		}
	}
}

func TestPairControlReservedTerminalExceptionDoesNotChangeOrdinaryStarts(t *testing.T) {
	for _, transport := range []pairing.PairControlTransport{pairing.ControlHTTPSPublish, pairing.ControlWebSocket} {
		state, record := terminalIngressFixture(t)
		if _, err := state.Accept(record(1, "1", "2", 1000, 0x71), transport, 1000); err == nil || controlErrorCode(t, err) != "invalid_generation_start" {
			t.Fatalf("ordinary initial error=%v", err)
		}
		if _, err := state.Accept(record(1, "1", "1", 1000, 0x72), transport, 1000); err != nil {
			t.Fatal(err)
		}
		if _, err := state.Accept(record(1, "2", "2", 1000, 0x73), transport, 1000); err == nil || controlErrorCode(t, err) != "invalid_generation_start" {
			t.Fatalf("ordinary higher generation error=%v", err)
		}
		if _, err := state.Accept(record(1, "2", "1", 1000, 0x74), transport, 1061); err == nil || controlErrorCode(t, err) != "timestamp_out_of_window" {
			t.Fatalf("ordinary stale timestamp error=%v", err)
		}
	}
	for _, kind := range []int{7, 8} {
		state, record := terminalIngressFixture(t)
		if _, err := state.Accept(record(kind, "1", "2", 1000, 0x75), pairing.ControlWebSocket, 1000); err == nil || controlErrorCode(t, err) != "invalid_generation_start" {
			t.Fatalf("WebSocket terminal bypass error=%v", err)
		}
		if _, err := state.Accept(record(kind, "1", "1", 1000, 0x76), pairing.ControlHTTPSPublish, 1000); err == nil || controlErrorCode(t, err) != "wrong_transport" {
			t.Fatalf("wrong terminal route error=%v", err)
		}
	}
}
