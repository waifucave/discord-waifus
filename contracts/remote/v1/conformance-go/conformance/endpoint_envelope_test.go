package conformance_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/vectors"
)

type endpointContextVector struct {
	NegotiatedMinor                 int    `json:"negotiatedMinor"`
	PairIDB64                       string `json:"pairIdB64"`
	SenderRole                      int    `json:"senderRole"`
	ReceiverRole                    int    `json:"receiverRole"`
	HostInstallationBundleHashB64   string `json:"hostInstallationBundleHashB64"`
	RemoteInstallationBundleHashB64 string `json:"remoteInstallationBundleHashB64"`
	HostTrustEpoch                  string `json:"hostTrustEpoch"`
	RemoteTrustEpoch                string `json:"remoteTrustEpoch"`
	EndpointEpoch                   string `json:"endpointEpoch"`
}

type endpointCandidateVector struct {
	Kind       int    `json:"kind"`
	Family     int    `json:"family"`
	AddressB64 string `json:"addressB64"`
	Port       int    `json:"port"`
	Priority   int64  `json:"priority"`
}

type endpointValueVector struct {
	Version              int                       `json:"version"`
	EndpointEpoch        string                    `json:"endpointEpoch"`
	ConnectionGeneration string                    `json:"connectionGeneration"`
	Candidates           []endpointCandidateVector `json:"candidates"`
}

type endpointEnvelopeVector struct {
	Name                string                `json:"name"`
	Context             endpointContextVector `json:"context"`
	Value               endpointValueVector   `json:"value"`
	PlaintextB64        string                `json:"plaintextB64"`
	NonceB64            string                `json:"nonceB64"`
	AssociatedDataB64   string                `json:"associatedDataB64"`
	CiphertextB64       string                `json:"ciphertextB64"`
	CiphertextSHA256B64 string                `json:"ciphertextSha256B64"`
}

type endpointRejectionVector struct {
	Name          string                `json:"name"`
	PlaintextB64  string                `json:"plaintextB64"`
	Context       endpointContextVector `json:"context"`
	CiphertextB64 string                `json:"ciphertextB64"`
	Approved      bool                  `json:"approved"`
	ErrorCode     string                `json:"errorCode"`
}

type endpointFixture struct {
	Keys struct {
		HostToRemoteKeyB64 string `json:"hostToRemoteKeyB64"`
		RemoteToHostKeyB64 string `json:"remoteToHostKeyB64"`
	} `json:"keys"`
	Envelopes    []endpointEnvelopeVector `json:"envelopes"`
	EpochAdvance struct {
		Context       endpointContextVector `json:"context"`
		Value         endpointValueVector   `json:"value"`
		CiphertextB64 string                `json:"ciphertextB64"`
	} `json:"epochAdvance"`
	Boundary struct {
		KeyB64                  string `json:"keyB64"`
		NonceB64                string `json:"nonceB64"`
		AssociatedDataB64       string `json:"associatedDataB64"`
		PlaintextB64            string `json:"plaintextB64"`
		CiphertextB64           string `json:"ciphertextB64"`
		OverLimitPlaintextB64   string `json:"overLimitPlaintextB64"`
		MaximumValidRecordBytes int    `json:"maximumValidRecordBytes"`
	} `json:"boundary"`
	Rejections struct {
		Plaintext []endpointRejectionVector `json:"plaintext"`
		Envelopes []endpointRejectionVector `json:"envelopes"`
	} `json:"rejections"`
}

func endpointFixtureBytes(t *testing.T) []byte {
	t.Helper()
	value, err := os.ReadFile(filepath.Join("..", "..", "fixtures", "crypto", "endpoint-envelope-v1.json"))
	if err != nil {
		t.Fatalf("read endpoint fixture: %v", err)
	}
	return value
}

func decodeEndpointFixture(t *testing.T) endpointFixture {
	t.Helper()
	var value endpointFixture
	if err := json.Unmarshal(endpointFixtureBytes(t), &value); err != nil {
		t.Fatalf("decode endpoint fixture: %v", err)
	}
	return value
}

func endpointUint64(t *testing.T, value string) uint64 {
	t.Helper()
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || strconv.FormatUint(parsed, 10) != value {
		t.Fatalf("parse endpoint uint64 %q: %v", value, err)
	}
	return parsed
}

func endpointContext(t *testing.T, value endpointContextVector) pairing.EndpointContext {
	t.Helper()
	if value.NegotiatedMinor < 0 || value.NegotiatedMinor > 65535 || value.SenderRole < 0 || value.SenderRole > 255 || value.ReceiverRole < 0 || value.ReceiverRole > 255 {
		t.Fatal("endpoint fixture context integer is out of range")
	}
	return pairing.EndpointContext{
		NegotiatedMinor:              uint16(value.NegotiatedMinor),
		PairID:                       decodeBase64URL(t, value.PairIDB64),
		SenderRole:                   uint8(value.SenderRole),
		ReceiverRole:                 uint8(value.ReceiverRole),
		HostInstallationBundleHash:   decodeBase64URL(t, value.HostInstallationBundleHashB64),
		RemoteInstallationBundleHash: decodeBase64URL(t, value.RemoteInstallationBundleHashB64),
		HostTrustEpoch:               endpointUint64(t, value.HostTrustEpoch),
		RemoteTrustEpoch:             endpointUint64(t, value.RemoteTrustEpoch),
		EndpointEpoch:                endpointUint64(t, value.EndpointEpoch),
	}
}

func endpointValue(t *testing.T, value endpointValueVector) pairing.EndpointGeneration {
	t.Helper()
	if value.Version < 0 || value.Version > 255 {
		t.Fatal("endpoint fixture version is out of range")
	}
	candidates := make([]pairing.EndpointCandidate, len(value.Candidates))
	for index, candidate := range value.Candidates {
		if candidate.Kind < 0 || candidate.Kind > 255 || candidate.Family < 0 || candidate.Family > 255 ||
			candidate.Port < 0 || candidate.Port > 65535 || candidate.Priority < 0 || candidate.Priority > 4294967295 {
			t.Fatalf("endpoint candidate %d integer is out of range", index)
		}
		candidates[index] = pairing.EndpointCandidate{
			Kind: uint8(candidate.Kind), Family: uint8(candidate.Family),
			Address: decodeBase64URL(t, candidate.AddressB64), Port: uint16(candidate.Port), Priority: uint32(candidate.Priority),
		}
	}
	return pairing.EndpointGeneration{
		Version: uint8(value.Version), EndpointEpoch: endpointUint64(t, value.EndpointEpoch),
		ConnectionGeneration: endpointUint64(t, value.ConnectionGeneration), Candidates: candidates,
	}
}

func endpointKeys(t *testing.T, fixture endpointFixture) pairing.EndpointDirectionKeys {
	t.Helper()
	return pairing.EndpointDirectionKeys{
		HostToRemote: decodeBase64URL(t, fixture.Keys.HostToRemoteKeyB64),
		RemoteToHost: decodeBase64URL(t, fixture.Keys.RemoteToHostKeyB64),
	}
}

func endpointErrorCode(t *testing.T, err error) string {
	t.Helper()
	var protocolError *pairing.EndpointError
	if !errors.As(err, &protocolError) {
		t.Fatalf("expected EndpointError, got %T: %v", err, err)
	}
	return protocolError.Code
}

func TestEndpointFixtureMatchesIndependentGenerator(t *testing.T) {
	expected, err := vectors.BuildEndpointEnvelopeV1JSON()
	if err != nil {
		t.Fatalf("build independent endpoint fixture: %v", err)
	}
	if !bytes.Equal(endpointFixtureBytes(t), expected) {
		t.Fatal("committed endpoint fixture differs from independent Go generator")
	}
}

func TestEndpointEnvelopesBothDirections(t *testing.T) {
	fixture := decodeEndpointFixture(t)
	keys := endpointKeys(t, fixture)
	if len(fixture.Envelopes) != 3 {
		t.Fatalf("expected three endpoint vectors, got %d", len(fixture.Envelopes))
	}
	for _, vector := range fixture.Envelopes {
		context := endpointContext(t, vector.Context)
		value := endpointValue(t, vector.Value)
		encrypted, err := pairing.EncryptEndpointEnvelope(keys, context, value, true)
		if err != nil {
			t.Fatalf("encrypt %s: %v", vector.Name, err)
		}
		comparisons := []struct {
			name string
			got  []byte
			want string
		}{
			{"plaintext", encrypted.Plaintext, vector.PlaintextB64},
			{"nonce", encrypted.Nonce, vector.NonceB64},
			{"associated data", encrypted.AssociatedData, vector.AssociatedDataB64},
			{"ciphertext", encrypted.Ciphertext, vector.CiphertextB64},
			{"ciphertext hash", pairing.Hash(encrypted.Ciphertext), vector.CiphertextSHA256B64},
		}
		for _, comparison := range comparisons {
			if pairing.B64(comparison.got) != comparison.want {
				t.Errorf("%s %s differs", vector.Name, comparison.name)
			}
		}
		decoded, err := pairing.DecodeEndpointPlaintext(encrypted.Plaintext)
		if err != nil || !reflect.DeepEqual(decoded, value) {
			t.Errorf("decode %s plaintext: %v", vector.Name, err)
		}
		minor := context.NegotiatedMinor
		decodedContext, err := pairing.DecodeEndpointAssociatedData(encrypted.AssociatedData, &minor)
		if err != nil || !reflect.DeepEqual(decodedContext, context) {
			t.Errorf("decode %s associated data: %v", vector.Name, err)
		}
		decrypted, err := pairing.DecryptEndpointEnvelope(keys, context, encrypted.Ciphertext, true)
		if err != nil || !reflect.DeepEqual(decrypted, value) {
			t.Errorf("decrypt %s envelope: %v", vector.Name, err)
		}
	}
}

func TestEndpointPlaintextAndEnvelopeRejections(t *testing.T) {
	fixture := decodeEndpointFixture(t)
	for _, rejection := range fixture.Rejections.Plaintext {
		_, err := pairing.DecodeEndpointPlaintext(decodeBase64URL(t, rejection.PlaintextB64))
		if err == nil || endpointErrorCode(t, err) != rejection.ErrorCode {
			t.Errorf("plaintext rejection %s returned %v", rejection.Name, err)
		}
	}
	keys := endpointKeys(t, fixture)
	for _, rejection := range fixture.Rejections.Envelopes {
		_, err := pairing.DecryptEndpointEnvelope(
			keys,
			endpointContext(t, rejection.Context),
			decodeBase64URL(t, rejection.CiphertextB64),
			rejection.Approved,
		)
		if err == nil || endpointErrorCode(t, err) != rejection.ErrorCode {
			t.Errorf("envelope rejection %s returned %v", rejection.Name, err)
		}
	}
}

func TestEndpointRawAEADBoundary(t *testing.T) {
	fixture := decodeEndpointFixture(t)
	key := decodeBase64URL(t, fixture.Boundary.KeyB64)
	nonce := decodeBase64URL(t, fixture.Boundary.NonceB64)
	associatedData := decodeBase64URL(t, fixture.Boundary.AssociatedDataB64)
	plaintext := decodeBase64URL(t, fixture.Boundary.PlaintextB64)
	ciphertext, err := pairing.EncryptEndpointAEAD(key, nonce, associatedData, plaintext)
	if err != nil {
		t.Fatalf("encrypt endpoint boundary: %v", err)
	}
	if len(plaintext) != pairing.EndpointPlaintextMax || len(ciphertext) != pairing.EndpointCiphertextMax || pairing.B64(ciphertext) != fixture.Boundary.CiphertextB64 {
		t.Fatal("endpoint AEAD boundary differs")
	}
	decrypted, err := pairing.DecryptEndpointAEAD(key, nonce, associatedData, ciphertext)
	if err != nil || !bytes.Equal(decrypted, plaintext) {
		t.Fatalf("decrypt endpoint boundary: %v", err)
	}
	_, err = pairing.EncryptEndpointAEAD(key, nonce, associatedData, decodeBase64URL(t, fixture.Boundary.OverLimitPlaintextB64))
	if err == nil || endpointErrorCode(t, err) != "plaintext_too_large" {
		t.Fatalf("over-limit endpoint plaintext returned %v", err)
	}
	if _, err := pairing.DecodeEndpointPlaintext(plaintext); err == nil || endpointErrorCode(t, err) != "invalid_canonical_cbor" {
		t.Fatalf("raw boundary was accepted as endpoint CBOR: %v", err)
	}
}

func TestEndpointReceiveStateRecoveryConflictAndRollback(t *testing.T) {
	fixture := decodeEndpointFixture(t)
	keys := endpointKeys(t, fixture)
	first := fixture.Envelopes[0]
	context := endpointContext(t, first.Context)
	ciphertext := decodeBase64URL(t, first.CiphertextB64)
	state, err := pairing.NewEndpointReceiveState()
	if err != nil {
		t.Fatalf("create endpoint receive state: %v", err)
	}
	prepared, err := state.Prepare(keys, context, ciphertext, true)
	if err != nil || prepared.Status != "prepared" || state.Snapshot().Phase != "prepared" {
		t.Fatalf("prepare endpoint: %+v %v", prepared, err)
	}
	restarted, err := pairing.NewEndpointReceiveState(state.Snapshot())
	if err != nil {
		t.Fatalf("restore endpoint state: %v", err)
	}
	resumed, err := restarted.Prepare(keys, context, ciphertext, true)
	if err != nil || resumed.Status != "resume_prepared" {
		t.Fatalf("resume endpoint: %+v %v", resumed, err)
	}
	if err := state.MarkApplied(context.EndpointEpoch, prepared.CiphertextSHA256); err != nil {
		t.Fatalf("mark endpoint applied: %v", err)
	}
	idempotent, err := state.Prepare(keys, context, ciphertext, true)
	if err != nil || idempotent.Status != "already_applied" {
		t.Fatalf("idempotent applied endpoint: %+v %v", idempotent, err)
	}
	if _, err := state.Prepare(keys, context, ciphertext, false); err == nil || endpointErrorCode(t, err) != "unapproved_sender" {
		t.Fatalf("unapproved idempotent endpoint returned %v", err)
	}
	conflict := append([]byte(nil), ciphertext...)
	conflict[0] ^= 1
	if _, err := state.Prepare(keys, context, conflict, true); err == nil || endpointErrorCode(t, err) != "epoch_conflict" {
		t.Fatalf("same-epoch conflict returned %v", err)
	}
	advancedContext := endpointContext(t, fixture.EpochAdvance.Context)
	advanced, err := state.Prepare(keys, advancedContext, decodeBase64URL(t, fixture.EpochAdvance.CiphertextB64), true)
	if err != nil || advanced.Status != "prepared" {
		t.Fatalf("advance endpoint epoch: %+v %v", advanced, err)
	}
	if _, err := state.Prepare(keys, context, ciphertext, true); err == nil || endpointErrorCode(t, err) != "epoch_rollback" {
		t.Fatalf("endpoint rollback returned %v", err)
	}
}
