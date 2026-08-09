package conformance_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/vectors"
)

type confirmationRecordFixture struct {
	Value             pairing.PairConfirmation `json:"value"`
	CanonicalBytesB64 string                   `json:"canonicalBytesB64"`
	MACInputB64       string                   `json:"macInputB64"`
}

type confirmationRejectionFixture struct {
	Name       string `json:"name"`
	PayloadB64 string `json:"payloadB64"`
	ErrorCode  string `json:"errorCode"`
	KeyB64     string `json:"keyB64"`
}

type confirmationFixture struct {
	ConfirmationKeyB64 string `json:"confirmationKeyB64"`
	Records            struct {
		Host   confirmationRecordFixture `json:"host"`
		Remote confirmationRecordFixture `json:"remote"`
	} `json:"records"`
	Rejections []confirmationRejectionFixture `json:"rejections"`
	Boundary   struct {
		AtLimitPayloadB64   string `json:"atLimitPayloadB64"`
		AtLimitOutcome      string `json:"atLimitOutcome"`
		OverLimitPayloadB64 string `json:"overLimitPayloadB64"`
		OverLimitOutcome    string `json:"overLimitOutcome"`
	} `json:"boundary"`
}

func confirmationFixtureBytes(t *testing.T) []byte {
	t.Helper()
	value, err := os.ReadFile(filepath.Join("..", "..", "fixtures", "crypto", "pair-confirmation-v1.json"))
	if err != nil {
		t.Fatalf("read committed pair confirmation fixture: %v", err)
	}
	return value
}

func decodeConfirmationFixture(t *testing.T) confirmationFixture {
	t.Helper()
	var fixture confirmationFixture
	if err := json.Unmarshal(confirmationFixtureBytes(t), &fixture); err != nil {
		t.Fatalf("decode pair confirmation fixture: %v", err)
	}
	return fixture
}

func confirmationErrorCode(t *testing.T, err error) string {
	t.Helper()
	var protocolError *pairing.ConfirmationError
	if !errors.As(err, &protocolError) {
		t.Fatalf("expected ConfirmationError, got %T: %v", err, err)
	}
	return protocolError.Code
}

func TestGoGeneratorMatchesCommittedPairConfirmationFixture(t *testing.T) {
	expected, err := vectors.BuildPairConfirmationV1JSON()
	if err != nil {
		t.Fatalf("build pair confirmation fixture: %v", err)
	}
	if !bytes.Equal(expected, confirmationFixtureBytes(t)) {
		t.Fatalf("Go-generated pair confirmation fixture differs from committed bytes")
	}
}

func TestPairConfirmationValidRecordsAndMACInputs(t *testing.T) {
	fixture := decodeConfirmationFixture(t)
	key := decodeBase64URL(t, fixture.ConfirmationKeyB64)
	for name, vector := range map[string]confirmationRecordFixture{
		"host": fixture.Records.Host, "remote": fixture.Records.Remote,
	} {
		t.Run(name, func(t *testing.T) {
			payload := decodeBase64URL(t, vector.CanonicalBytesB64)
			parsed, err := pairing.ParseAndVerifyPairConfirmation(payload, key)
			if err != nil {
				t.Fatalf("parse valid confirmation: %v", err)
			}
			if parsed != vector.Value {
				t.Fatalf("parsed confirmation differs from fixture")
			}
			macInput, err := pairing.PairConfirmationMACInput(parsed)
			if err != nil {
				t.Fatalf("derive confirmation MAC input: %v", err)
			}
			if !bytes.Equal(macInput, decodeBase64URL(t, vector.MACInputB64)) {
				t.Fatalf("confirmation MAC input differs from public vector")
			}
		})
	}
}

func TestPairConfirmationRejectionsAndBoundary(t *testing.T) {
	fixture := decodeConfirmationFixture(t)
	defaultKey := decodeBase64URL(t, fixture.ConfirmationKeyB64)
	for _, vector := range fixture.Rejections {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			key := defaultKey
			if vector.KeyB64 != "" {
				key = decodeBase64URL(t, vector.KeyB64)
			}
			_, err := pairing.ParseAndVerifyPairConfirmation(decodeBase64URL(t, vector.PayloadB64), key)
			if err == nil {
				t.Fatalf("invalid pair confirmation was accepted")
			}
			if got := confirmationErrorCode(t, err); got != vector.ErrorCode {
				t.Fatalf("error code = %q, want %q", got, vector.ErrorCode)
			}
		})
	}
	for name, vector := range map[string]struct {
		payload string
		code    string
	}{
		"at-limit":   {fixture.Boundary.AtLimitPayloadB64, fixture.Boundary.AtLimitOutcome},
		"over-limit": {fixture.Boundary.OverLimitPayloadB64, fixture.Boundary.OverLimitOutcome},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := pairing.ParseAndVerifyPairConfirmation(decodeBase64URL(t, vector.payload), defaultKey)
			if err == nil || confirmationErrorCode(t, err) != vector.code {
				t.Fatalf("boundary outcome differs: %v", err)
			}
		})
	}
}

func TestPairConfirmationPublishVerifyConsumeOrder(t *testing.T) {
	fixture := decodeConfirmationFixture(t)
	key := decodeBase64URL(t, fixture.ConfirmationKeyB64)
	hostValue := fixture.Records.Host.Value
	remoteValue := fixture.Records.Remote.Value
	context := pairing.PairConfirmationContext{
		InvitationID: hostValue.InvitationID, InvitationGeneration: hostValue.InvitationGeneration,
		PairID: hostValue.PairID, TranscriptHash: hostValue.TranscriptHash,
		ChannelBinding: hostValue.ChannelBinding, HostBundleHash: hostValue.HostBundleHash,
		RemoteBundleHash: hostValue.RemoteBundleHash, ApprovalContextHash: hostValue.ApprovalContextHash,
	}
	host, err := pairing.NewConfirmationSession(1, key, context)
	if err != nil {
		t.Fatalf("create host confirmation session: %v", err)
	}
	remote, err := pairing.NewConfirmationSession(2, key, context)
	if err != nil {
		t.Fatalf("create remote confirmation session: %v", err)
	}
	if _, err := host.PublishLocal(hostValue); confirmationErrorCode(t, err) != "invalid_phase" {
		t.Fatalf("pre-approval publish was not rejected")
	}
	if _, err := host.Approve(); err != nil {
		t.Fatalf("approve host confirmation session: %v", err)
	}
	if _, err := remote.Approve(); err != nil {
		t.Fatalf("approve remote confirmation session: %v", err)
	}
	remotePayload := decodeBase64URL(t, fixture.Records.Remote.CanonicalBytesB64)
	if _, err := host.ReceivePeer("pair_confirmation", remotePayload); confirmationErrorCode(t, err) != "local_not_published" {
		t.Fatalf("peer verification before local publish was not rejected")
	}
	if changed, err := host.PublishLocal(hostValue); err != nil || !changed {
		t.Fatalf("publish host confirmation: changed=%v err=%v", changed, err)
	}
	if changed, err := remote.PublishLocal(remoteValue); err != nil || !changed {
		t.Fatalf("publish remote confirmation: changed=%v err=%v", changed, err)
	}
	if changed, err := host.PublishLocal(hostValue); err != nil || changed {
		t.Fatalf("same local publish is not idempotent: changed=%v err=%v", changed, err)
	}
	if _, err := host.Consume(); confirmationErrorCode(t, err) != "peer_not_verified" {
		t.Fatalf("consume before peer verification was not rejected")
	}
	if _, err := host.ReceivePeer("noise_transport", remotePayload); confirmationErrorCode(t, err) != "wrong_record_type" {
		t.Fatalf("Noise transport record type was not rejected")
	}
	alternateHost := hostValue
	alternateHost.ConfirmationNonce = pairing.B64(bytes.Repeat([]byte{0xa1}, 16))
	alternateHost.ConfirmationMAC = ""
	alternateHost, err = pairing.CreatePairConfirmation(key, alternateHost)
	if err != nil {
		t.Fatalf("create alternate host confirmation: %v", err)
	}
	if _, err := host.PublishLocal(alternateHost); confirmationErrorCode(t, err) != "duplicate_confirmation" {
		t.Fatalf("different second local confirmation was not rejected")
	}
	if changed, err := host.ReceivePeer("pair_confirmation", remotePayload); err != nil || !changed {
		t.Fatalf("host verify remote confirmation: %v", err)
	}
	if changed, err := host.ReceivePeer("pair_confirmation", remotePayload); err != nil || changed {
		t.Fatalf("same peer confirmation is not idempotent: changed=%v err=%v", changed, err)
	}
	alternateRemote := remoteValue
	alternateRemote.ConfirmationNonce = pairing.B64(bytes.Repeat([]byte{0xb1}, 16))
	alternateRemote.ConfirmationMAC = ""
	alternateRemote, err = pairing.CreatePairConfirmation(key, alternateRemote)
	if err != nil {
		t.Fatalf("create alternate remote confirmation: %v", err)
	}
	alternateRemotePayload, err := pairing.CanonicalPairConfirmationJSON(alternateRemote)
	if err != nil {
		t.Fatalf("encode alternate remote confirmation: %v", err)
	}
	if _, err := host.ReceivePeer("pair_confirmation", alternateRemotePayload); confirmationErrorCode(t, err) != "duplicate_confirmation" {
		t.Fatalf("different second peer confirmation was not rejected")
	}
	if _, err := remote.ReceivePeer("pair_confirmation", decodeBase64URL(t, fixture.Records.Host.CanonicalBytesB64)); err != nil {
		t.Fatalf("remote verify host confirmation: %v", err)
	}
	if changed, err := host.Consume(); err != nil || !changed {
		t.Fatalf("host consume: changed=%v err=%v", changed, err)
	}
	if changed, err := remote.Consume(); err != nil || !changed {
		t.Fatalf("remote consume: changed=%v err=%v", changed, err)
	}
	if changed, err := host.Consume(); err != nil || changed {
		t.Fatalf("same consume is not idempotent: changed=%v err=%v", changed, err)
	}
	if _, err := host.PublishLocal(hostValue); confirmationErrorCode(t, err) != "invalid_phase" {
		t.Fatalf("post-consume publish was not rejected")
	}

	cancelled, err := pairing.NewConfirmationSession(1, key, context)
	if err != nil {
		t.Fatalf("create cancelled confirmation session: %v", err)
	}
	if _, err := cancelled.Approve(); err != nil {
		t.Fatalf("approve cancelled confirmation session: %v", err)
	}
	if err := cancelled.Cancel(); err != nil {
		t.Fatalf("cancel confirmation session: %v", err)
	}
	if _, err := cancelled.PublishLocal(hostValue); confirmationErrorCode(t, err) != "invalid_phase" {
		t.Fatalf("post-cancel publish was not rejected")
	}
	expired, err := pairing.NewConfirmationSession(1, key, context)
	if err != nil {
		t.Fatalf("create expired confirmation session: %v", err)
	}
	if _, err := expired.Approve(); err != nil {
		t.Fatalf("approve expired confirmation session: %v", err)
	}
	if err := expired.Expire(); err != nil {
		t.Fatalf("expire confirmation session: %v", err)
	}
	if _, err := expired.PublishLocal(hostValue); confirmationErrorCode(t, err) != "invalid_phase" {
		t.Fatalf("post-expiry publish was not rejected")
	}
}
