package conformance_test

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/vectors"
	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/wipc"
)

func protocolErrorCode(t *testing.T, err error) string {
	t.Helper()
	var protocolError *wipc.ProtocolError
	if !errors.As(err, &protocolError) {
		t.Fatalf("expected ProtocolError, got %T: %v", err, err)
	}
	return protocolError.Code
}

func fixtureBytes(t *testing.T) []byte {
	t.Helper()
	value, err := os.ReadFile(filepath.Join("..", "..", "fixtures", "crypto", "wipc-v1.json"))
	if err != nil {
		t.Fatalf("read committed WIPC fixture: %v", err)
	}
	return value
}

func decodeBase64URL(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		t.Fatalf("decode base64url: %v", err)
	}
	return decoded
}

func parseUint64(t *testing.T, value string) uint64 {
	t.Helper()
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		t.Fatalf("parse uint64 %q: %v", value, err)
	}
	return parsed
}

func TestGoGeneratorMatchesCommittedWIPCV1Fixture(t *testing.T) {
	expected, err := vectors.BuildWIPCV1JSON()
	if err != nil {
		t.Fatalf("build WIPC fixture: %v", err)
	}
	actual := fixtureBytes(t)
	if !bytes.Equal(actual, expected) {
		t.Fatalf("Go-generated WIPC fixture differs from committed bytes")
	}
}

func TestWIPCHeaderVectors(t *testing.T) {
	fixture, err := vectors.DecodeWIPCV1Fixture(fixtureBytes(t))
	if err != nil {
		t.Fatalf("decode fixture: %v", err)
	}

	for _, vector := range fixture.ValidHeaders {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			wire, err := hex.DecodeString(vector.WireHex)
			if err != nil {
				t.Fatalf("decode header hex: %v", err)
			}
			header, err := wipc.DecodeHeader(wire)
			if err != nil {
				t.Fatalf("decode valid header: %v", err)
			}
			if header.Major != vector.Fields.Major ||
				header.Minor != vector.Fields.Minor ||
				header.FrameType != vector.Fields.FrameType ||
				header.Flags != vector.Fields.Flags ||
				header.StreamID != parseUint64(t, vector.Fields.StreamID) ||
				header.PayloadLength != vector.Fields.PayloadLength {
				t.Fatalf("decoded header mismatch: %#v versus %#v", header, vector.Fields)
			}
			reencoded, err := wipc.EncodeHeader(header)
			if err != nil {
				t.Fatalf("re-encode valid header: %v", err)
			}
			if !bytes.Equal(reencoded, wire) {
				t.Fatalf("header did not round-trip byte-for-byte")
			}
		})
	}

	for _, vector := range fixture.InvalidHeaders {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			wire, err := hex.DecodeString(vector.WireHex)
			if err != nil {
				t.Fatalf("decode invalid header hex: %v", err)
			}
			_, err = wipc.DecodeHeader(wire)
			if err == nil {
				t.Fatalf("invalid header was accepted")
			}
			if got := protocolErrorCode(t, err); got != vector.ErrorCode {
				t.Fatalf("error code = %q, want %q", got, vector.ErrorCode)
			}
		})
	}
}

func TestWIPCWindowUpdateVectors(t *testing.T) {
	fixture, err := vectors.DecodeWIPCV1Fixture(fixtureBytes(t))
	if err != nil {
		t.Fatalf("decode fixture: %v", err)
	}

	for _, vector := range fixture.ValidWindowUpdates {
		wire, err := hex.DecodeString(vector.WireHex)
		if err != nil {
			t.Fatalf("decode window hex: %v", err)
		}
		update, err := wipc.DecodeWindowUpdate(wire)
		if err != nil {
			t.Fatalf("decode valid window update: %v", err)
		}
		if update.Direction.String() != vector.Direction || update.CreditIncrement != vector.CreditIncrement {
			t.Fatalf("decoded window update mismatch: %#v", update)
		}
		reencoded, err := wipc.EncodeWindowUpdate(update)
		if err != nil {
			t.Fatalf("re-encode valid window update: %v", err)
		}
		if !bytes.Equal(reencoded, wire) {
			t.Fatalf("window update did not round-trip byte-for-byte")
		}
	}

	for _, vector := range fixture.InvalidWindowUpdates {
		wire, err := hex.DecodeString(vector.WireHex)
		if err != nil {
			t.Fatalf("decode invalid window hex: %v", err)
		}
		_, err = wipc.DecodeWindowUpdate(wire)
		if err == nil {
			t.Fatalf("invalid window update %q was accepted", vector.Name)
		}
		if got := protocolErrorCode(t, err); got != vector.ErrorCode {
			t.Fatalf("%s error code = %q, want %q", vector.Name, got, vector.ErrorCode)
		}
	}
}

func TestWIPCAuthenticationVectors(t *testing.T) {
	fixture, err := vectors.DecodeWIPCV1Fixture(fixtureBytes(t))
	if err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	auth := fixture.Authentication
	capability := decodeBase64URL(t, auth.ParentCapabilityB64)
	clientNonce := decodeBase64URL(t, auth.ClientNonceB64)
	helperNonce := decodeBase64URL(t, auth.HelperNonceB64)
	hello := decodeBase64URL(t, auth.HelloBytesB64)
	helloAck := decodeBase64URL(t, auth.HelloAckBytesB64)
	expectedParent := decodeBase64URL(t, auth.ParentProofB64)
	expectedHelper := decodeBase64URL(t, auth.HelperProofB64)

	parentProof, err := wipc.ParentProof(capability, clientNonce, helperNonce, hello, helloAck)
	if err != nil {
		t.Fatalf("derive parent proof: %v", err)
	}
	if !bytes.Equal(parentProof, expectedParent) {
		t.Fatalf("parent proof differs from public vector")
	}
	helperProof, err := wipc.HelperProof(
		capability,
		clientNonce,
		helperNonce,
		hello,
		helloAck,
		parentProof,
	)
	if err != nil {
		t.Fatalf("derive helper proof: %v", err)
	}
	if !bytes.Equal(helperProof, expectedHelper) {
		t.Fatalf("helper proof differs from public vector")
	}

	for _, vector := range auth.RejectionVectors {
		candidate := decodeBase64URL(t, vector.ProofB64)
		candidateHello := decodeBase64URL(t, vector.HelloBytesB64)
		var accepted bool
		switch vector.ProofKind {
		case "parent":
			accepted, err = wipc.VerifyParentProof(
				capability,
				clientNonce,
				helperNonce,
				candidateHello,
				helloAck,
				candidate,
			)
		case "helper":
			accepted, err = wipc.VerifyHelperProof(
				capability,
				clientNonce,
				helperNonce,
				candidateHello,
				helloAck,
				parentProof,
				candidate,
			)
		default:
			t.Fatalf("unknown proof kind %q", vector.ProofKind)
		}
		if err != nil {
			t.Fatalf("verify rejection vector %q: %v", vector.Name, err)
		}
		if accepted {
			t.Fatalf("rejection vector %q was accepted", vector.Name)
		}
	}
}

func TestWIPCStreamIDVectors(t *testing.T) {
	fixture, err := vectors.DecodeWIPCV1Fixture(fixtureBytes(t))
	if err != nil {
		t.Fatalf("decode fixture: %v", err)
	}

	for _, vector := range fixture.StreamIDVectors {
		after, err := wipc.AcceptStreamID(
			wipc.Creator(vector.Creator),
			parseUint64(t, vector.HighestBefore),
			parseUint64(t, vector.StreamID),
		)
		if vector.Outcome == "accept" {
			if err != nil {
				t.Fatalf("accept stream vector failed: %v", err)
			}
			if after != parseUint64(t, vector.HighestAfter) {
				t.Fatalf("high-water = %d, want %s", after, vector.HighestAfter)
			}
			continue
		}
		if err == nil {
			t.Fatalf("reject stream vector was accepted")
		}
		if got := protocolErrorCode(t, err); got != vector.Outcome {
			t.Fatalf("stream error code = %q, want %q", got, vector.Outcome)
		}
		if after != parseUint64(t, vector.HighestAfter) {
			t.Fatalf("rejected stream changed high-water to %d", after)
		}
	}

	for _, vector := range fixture.AllocatorVectors {
		next, err := wipc.NextStreamID(
			wipc.Creator(vector.Creator),
			parseUint64(t, vector.HighestBefore),
		)
		if vector.Outcome == "accept" {
			if err != nil {
				t.Fatalf("allocate stream vector failed: %v", err)
			}
			if next != parseUint64(t, vector.NextStreamID) {
				t.Fatalf("next stream ID = %d, want %s", next, vector.NextStreamID)
			}
			continue
		}
		if err == nil {
			t.Fatalf("exhausted stream allocator was accepted")
		}
		if got := protocolErrorCode(t, err); got != vector.Outcome {
			t.Fatalf("allocator error code = %q, want %q", got, vector.Outcome)
		}
	}
}
