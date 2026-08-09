package conformance_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/vectors"
)

type serviceSessionInputs struct {
	NegotiatedMinor                 int    `json:"negotiatedMinor"`
	PairIDB64                       string `json:"pairIdB64"`
	ServiceIDB64                    string `json:"serviceIdB64"`
	HostNonceB64                    string `json:"hostNonceB64"`
	RemoteNonceB64                  string `json:"remoteNonceB64"`
	HostInstallationBundleHashB64   string `json:"hostInstallationBundleHashB64"`
	RemoteInstallationBundleHashB64 string `json:"remoteInstallationBundleHashB64"`
	HostTrustEpoch                  string `json:"hostTrustEpoch"`
	RemoteTrustEpoch                string `json:"remoteTrustEpoch"`
	HostTransportSessionIDB64       string `json:"hostTransportSessionIdB64"`
	RemoteTransportSessionIDB64     string `json:"remoteTransportSessionIdB64"`
}

type serviceSessionRejection struct {
	Name   string               `json:"name"`
	Inputs serviceSessionInputs `json:"inputs"`
}

type serviceEncodingRejection struct {
	Name          string `json:"name"`
	PayloadB64    string `json:"payloadB64"`
	ExpectedMinor int    `json:"expectedMinor"`
}

type serviceBrowserRejection struct {
	Name     string          `json:"name"`
	Envelope json.RawMessage `json:"envelope"`
}

type serviceApprovalVector struct {
	Kind              string          `json:"kind"`
	Value             json.RawMessage `json:"value"`
	CanonicalBytesB64 string          `json:"canonicalBytesB64"`
	ContextHashB64    string          `json:"contextHashB64"`
}

type serviceSessionFixture struct {
	ApplicationSession struct {
		Inputs                         serviceSessionInputs `json:"inputs"`
		HostInstallationSeedB64        string               `json:"hostInstallationSeedB64"`
		RemoteInstallationSeedB64      string               `json:"remoteInstallationSeedB64"`
		HostInstallationPublicKeyB64   string               `json:"hostInstallationPublicKeyB64"`
		RemoteInstallationPublicKeyB64 string               `json:"remoteInstallationPublicKeyB64"`
		SignedBytesB64                 string               `json:"signedBytesB64"`
		DigestB64                      string               `json:"digestB64"`
		HostSignatureB64               string               `json:"hostSignatureB64"`
		RemoteSignatureB64             string               `json:"remoteSignatureB64"`
		ApplicationSessionHashB64      string               `json:"applicationSessionHashB64"`
	} `json:"applicationSession"`
	RemoteBrowserContext struct {
		PairRootB64              string                               `json:"pairRootB64"`
		AcceptedAt               string                               `json:"acceptedAt"`
		GatewayExpiresAt         string                               `json:"gatewayExpiresAt"`
		CanonicalContextBytesB64 string                               `json:"canonicalContextBytesB64"`
		BrowserContextKeyB64     string                               `json:"browserContextKeyB64"`
		MACInputB64              string                               `json:"macInputB64"`
		Envelope                 pairing.RemoteBrowserContextEnvelope `json:"envelope"`
	} `json:"remoteBrowserContext"`
	ApprovalReceipts []serviceApprovalVector `json:"approvalReceipts"`
	Rejections       struct {
		ApplicationSession             []serviceSessionRejection  `json:"applicationSession"`
		ApplicationSessionEncoding     []serviceEncodingRejection `json:"applicationSessionEncoding"`
		RemoteBrowserContext           []serviceBrowserRejection  `json:"remoteBrowserContext"`
		RemoteBrowserContextStructural []serviceBrowserRejection  `json:"remoteBrowserContextStructural"`
	} `json:"rejections"`
}

func serviceFixtureBytes(t *testing.T) []byte {
	t.Helper()
	value, err := os.ReadFile(filepath.Join("..", "..", "fixtures", "crypto", "service-session-v1.json"))
	if err != nil {
		t.Fatalf("read committed service-session fixture: %v", err)
	}
	return value
}

func decodeServiceFixture(t *testing.T) serviceSessionFixture {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(serviceFixtureBytes(t)))
	var fixture serviceSessionFixture
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("decode service-session fixture: %v", err)
	}
	return fixture
}

func serviceUint64(t *testing.T, value string) uint64 {
	t.Helper()
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || strconv.FormatUint(parsed, 10) != value {
		t.Fatalf("parse canonical uint64 %q: %v", value, err)
	}
	return parsed
}

func serviceInput(t *testing.T, value serviceSessionInputs) pairing.ApplicationSessionContext {
	t.Helper()
	if value.NegotiatedMinor < 0 || value.NegotiatedMinor > 65535 {
		t.Fatalf("invalid negotiated minor %d", value.NegotiatedMinor)
	}
	return pairing.ApplicationSessionContext{
		NegotiatedMinor:              uint16(value.NegotiatedMinor),
		PairID:                       decodeBase64URL(t, value.PairIDB64),
		ServiceID:                    decodeBase64URL(t, value.ServiceIDB64),
		HostNonce:                    decodeBase64URL(t, value.HostNonceB64),
		RemoteNonce:                  decodeBase64URL(t, value.RemoteNonceB64),
		HostInstallationBundleHash:   decodeBase64URL(t, value.HostInstallationBundleHashB64),
		RemoteInstallationBundleHash: decodeBase64URL(t, value.RemoteInstallationBundleHashB64),
		HostTrustEpoch:               serviceUint64(t, value.HostTrustEpoch),
		RemoteTrustEpoch:             serviceUint64(t, value.RemoteTrustEpoch),
		HostTransportSessionID:       decodeBase64URL(t, value.HostTransportSessionIDB64),
		RemoteTransportSessionID:     decodeBase64URL(t, value.RemoteTransportSessionIDB64),
	}
}

func serviceErrorCode(t *testing.T, err error) string {
	t.Helper()
	var protocolError *pairing.ServiceError
	if !errors.As(err, &protocolError) {
		t.Fatalf("expected ServiceError, got %T: %v", err, err)
	}
	return protocolError.Code
}

func decodeStrictBrowserEnvelope(t *testing.T, encoded []byte) (pairing.RemoteBrowserContextEnvelope, error) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var value pairing.RemoteBrowserContextEnvelope
	if err := decoder.Decode(&value); err != nil {
		return pairing.RemoteBrowserContextEnvelope{}, err
	}
	return value, pairing.ValidateRemoteBrowserContextEnvelope(value)
}

func TestServiceSessionFixtureMatchesIndependentGenerator(t *testing.T) {
	expected, err := vectors.BuildServiceSessionV1JSON()
	if err != nil {
		t.Fatalf("build independent service-session fixture: %v", err)
	}
	if !bytes.Equal(serviceFixtureBytes(t), expected) {
		t.Fatal("committed service-session fixture differs from independent Go generator")
	}
}

func TestApplicationSessionProofsAndCanonicalDecoder(t *testing.T) {
	fixture := decodeServiceFixture(t)
	value := serviceInput(t, fixture.ApplicationSession.Inputs)
	proofs, err := pairing.CreateApplicationSessionProofs(
		value,
		decodeBase64URL(t, fixture.ApplicationSession.HostInstallationSeedB64),
		decodeBase64URL(t, fixture.ApplicationSession.RemoteInstallationSeedB64),
	)
	if err != nil {
		t.Fatalf("create application-session proofs: %v", err)
	}
	comparisons := []struct {
		name string
		got  []byte
		want string
	}{
		{"signed bytes", proofs.SignedBytes, fixture.ApplicationSession.SignedBytesB64},
		{"digest", proofs.Digest, fixture.ApplicationSession.DigestB64},
		{"host signature", proofs.HostSignature, fixture.ApplicationSession.HostSignatureB64},
		{"remote signature", proofs.RemoteSignature, fixture.ApplicationSession.RemoteSignatureB64},
		{"application-session hash", proofs.ApplicationSessionHash, fixture.ApplicationSession.ApplicationSessionHashB64},
	}
	for _, comparison := range comparisons {
		if pairing.B64(comparison.got) != comparison.want {
			t.Errorf("%s differs", comparison.name)
		}
	}
	if !pairing.VerifyApplicationSessionProofs(
		value,
		decodeBase64URL(t, fixture.ApplicationSession.HostInstallationPublicKeyB64),
		decodeBase64URL(t, fixture.ApplicationSession.RemoteInstallationPublicKeyB64),
		proofs.HostSignature,
		proofs.RemoteSignature,
	) {
		t.Fatal("valid application-session proofs rejected")
	}
	minor := uint16(0)
	decoded, err := pairing.DecodeApplicationSessionSignedBytes(proofs.SignedBytes, &minor)
	if err != nil {
		t.Fatalf("decode canonical application-session bytes: %v", err)
	}
	reencoded, err := pairing.EncodeApplicationSessionSignedBytes(decoded)
	if err != nil || !bytes.Equal(reencoded, proofs.SignedBytes) {
		t.Fatalf("application-session decoder did not round trip: %v", err)
	}

	for _, rejection := range fixture.Rejections.ApplicationSession {
		if pairing.VerifyApplicationSessionProofs(
			serviceInput(t, rejection.Inputs),
			decodeBase64URL(t, fixture.ApplicationSession.HostInstallationPublicKeyB64),
			decodeBase64URL(t, fixture.ApplicationSession.RemoteInstallationPublicKeyB64),
			proofs.HostSignature,
			proofs.RemoteSignature,
		) {
			t.Errorf("accepted application-session substitution %s", rejection.Name)
		}
	}
	for _, rejection := range fixture.Rejections.ApplicationSessionEncoding {
		expectedMinor := uint16(rejection.ExpectedMinor)
		_, err := pairing.DecodeApplicationSessionSignedBytes(decodeBase64URL(t, rejection.PayloadB64), &expectedMinor)
		if err == nil || serviceErrorCode(t, err) != "invalid_application_session" {
			t.Errorf("encoding rejection %s returned %v", rejection.Name, err)
		}
	}
}

func TestApplicationSessionFourMessageGate(t *testing.T) {
	sequences := map[string][]string{
		"remote": {"send_hello", "receive_verified_hello_ack", "send_authenticate_peer", "receive_success_result"},
		"host":   {"receive_hello", "send_hello_ack", "receive_verified_authenticate_peer", "send_success_result"},
	}
	for role, events := range sequences {
		state, err := pairing.NewApplicationSessionAuthentication(role)
		if err != nil {
			t.Fatalf("create %s state: %v", role, err)
		}
		for index, event := range events {
			if state.CanAcceptRequestStart() {
				t.Fatalf("%s accepted REQUEST_START before event %d", role, index)
			}
			if err := state.Transition(event); err != nil {
				t.Fatalf("%s transition %s: %v", role, event, err)
			}
		}
		if !state.CanAcceptRequestStart() || state.State != "authenticated" {
			t.Fatalf("%s did not authenticate", role)
		}
	}
	invalid, _ := pairing.NewApplicationSessionAuthentication("host")
	if err := invalid.Transition("receive_verified_authenticate_peer"); err == nil || serviceErrorCode(t, err) != "auth_sequence_error" {
		t.Fatalf("out-of-order authentication returned %v", err)
	}
}

func TestRemoteBrowserContextCryptoAndStrictRejections(t *testing.T) {
	fixture := decodeServiceFixture(t)
	session := serviceInput(t, fixture.ApplicationSession.Inputs)
	envelope := fixture.RemoteBrowserContext.Envelope
	key, err := pairing.DeriveRemoteBrowserContextKey(
		decodeBase64URL(t, fixture.RemoteBrowserContext.PairRootB64),
		decodeBase64URL(t, fixture.ApplicationSession.ApplicationSessionHashB64),
		session,
	)
	if err != nil {
		t.Fatalf("derive browser-context key: %v", err)
	}
	if pairing.B64(key) != fixture.RemoteBrowserContext.BrowserContextKeyB64 {
		t.Fatal("browser-context key differs")
	}
	canonical, err := pairing.CanonicalRemoteBrowserContextJSON(envelope.BrowserContext)
	if err != nil || pairing.B64(canonical) != fixture.RemoteBrowserContext.CanonicalContextBytesB64 {
		t.Fatalf("canonical browser context differs: %v", err)
	}
	if _, err := pairing.ParseCanonicalRemoteBrowserContext(canonical); err != nil {
		t.Fatalf("canonical browser context rejected: %v", err)
	}
	macInput, err := pairing.RemoteBrowserContextMACInput(envelope)
	if err != nil || pairing.B64(macInput) != fixture.RemoteBrowserContext.MACInputB64 {
		t.Fatalf("browser-context MAC input differs: %v", err)
	}
	if !pairing.VerifyRemoteBrowserContextMAC(key, envelope) {
		t.Fatal("valid browser-context MAC rejected")
	}

	for _, rejection := range fixture.Rejections.RemoteBrowserContext {
		value, err := decodeStrictBrowserEnvelope(t, rejection.Envelope)
		if err != nil {
			t.Errorf("MAC rejection %s is not structurally valid: %v", rejection.Name, err)
			continue
		}
		if pairing.VerifyRemoteBrowserContextMAC(key, value) {
			t.Errorf("accepted browser-context substitution %s", rejection.Name)
		}
	}
	for _, rejection := range fixture.Rejections.RemoteBrowserContextStructural {
		if _, err := decodeStrictBrowserEnvelope(t, rejection.Envelope); err == nil {
			t.Errorf("accepted structural browser-context rejection %s", rejection.Name)
		}
	}
}

func TestRemoteBrowserContextReplayAndStateGate(t *testing.T) {
	fixture := decodeServiceFixture(t)
	value := fixture.RemoteBrowserContext.Envelope
	key := decodeBase64URL(t, fixture.RemoteBrowserContext.BrowserContextKeyB64)
	guard, err := pairing.NewRemoteBrowserReplayGuard(pairing.RemoteBrowserReplayConfig{
		PairID: value.PairID, RemoteDeviceID: value.RemoteDeviceID,
		RemoteInstallationBundleHash: value.RemoteInstallationBundleHash,
		HostTrustEpoch:               value.HostTrustEpoch, RemoteTrustEpoch: value.RemoteTrustEpoch,
		GatewayLaunchID:  value.BrowserContext.GatewayLaunchID,
		BrowserSessionID: value.BrowserContext.BrowserSessionID,
		GatewayExpiresAt: fixture.RemoteBrowserContext.GatewayExpiresAt,
	})
	if err != nil {
		t.Fatalf("create replay guard: %v", err)
	}
	if err := guard.VerifyAndConsume(
		value, key, value.ApplicationSessionHash, fixture.RemoteBrowserContext.AcceptedAt,
		value.BrowserContext.Method, value.BrowserContext.CanonicalTarget,
	); err != nil {
		t.Fatalf("consume valid browser context: %v", err)
	}
	if err := guard.VerifyAndConsume(
		value, key, value.ApplicationSessionHash, fixture.RemoteBrowserContext.AcceptedAt,
		value.BrowserContext.Method, value.BrowserContext.CanonicalTarget,
	); err == nil || serviceErrorCode(t, err) != "replayed_request_nonce" {
		t.Fatalf("replayed browser context returned %v", err)
	}

	fresh := value
	fresh.BrowserContext.RequestNonce = pairing.B64(bytes.Repeat([]byte{0x91}, 16))
	fresh.DirectRequestID = pairing.B64(bytes.Repeat([]byte{0x92}, 16))
	fresh.RemoteParentStreamID = "9007199254740995"
	fresh, err = pairing.SignRemoteBrowserContextEnvelope(key, fresh)
	if err != nil {
		t.Fatalf("sign fresh browser context: %v", err)
	}
	expired := strconv.FormatUint(serviceUint64(t, fixture.RemoteBrowserContext.GatewayExpiresAt)+1, 10)
	if err := guard.VerifyAndConsume(
		fresh, key, fresh.ApplicationSessionHash, expired,
		fresh.BrowserContext.Method, fresh.BrowserContext.CanonicalTarget,
	); err == nil || serviceErrorCode(t, err) != "gateway_launch_expired" {
		t.Fatalf("expired gateway launch returned %v", err)
	}
	if err := guard.VerifyAndConsume(
		fresh, key, fresh.ApplicationSessionHash, fixture.RemoteBrowserContext.AcceptedAt,
		"GET", fresh.BrowserContext.CanonicalTarget,
	); err == nil || serviceErrorCode(t, err) != "request_binding_mismatch" {
		t.Fatalf("request binding substitution returned %v", err)
	}
}

func TestApprovalReceiptCanonicalBytesAndContextHash(t *testing.T) {
	fixture := decodeServiceFixture(t)
	if len(fixture.ApprovalReceipts) != 2 {
		t.Fatalf("expected two approval receipt vectors, got %d", len(fixture.ApprovalReceipts))
	}
	for _, vector := range fixture.ApprovalReceipts {
		decoder := json.NewDecoder(bytes.NewReader(vector.Value))
		decoder.UseNumber()
		var value any
		if err := decoder.Decode(&value); err != nil {
			t.Fatalf("decode %s approval receipt: %v", vector.Kind, err)
		}
		canonical, contextHash, err := pairing.ApprovalContextHash(value)
		if err != nil {
			t.Fatalf("hash %s approval receipt: %v", vector.Kind, err)
		}
		if pairing.B64(canonical) != vector.CanonicalBytesB64 || pairing.B64(contextHash) != vector.ContextHashB64 {
			t.Errorf("%s approval receipt vector differs", vector.Kind)
		}
		if !bytes.Equal(canonical, vector.Value) {
			t.Errorf("%s approval receipt is not canonical JSON", vector.Kind)
		}
	}
	invalidPaths, err := filepath.Glob(filepath.Join("..", "..", "fixtures", "invalid", "approval-receipt-*.json"))
	if err != nil || len(invalidPaths) == 0 {
		t.Fatalf("find invalid approval receipt fixtures: %v", err)
	}
	for _, invalidPath := range invalidPaths {
		encoded, err := os.ReadFile(invalidPath)
		if err != nil {
			t.Fatalf("read %s: %v", invalidPath, err)
		}
		decoder := json.NewDecoder(bytes.NewReader(encoded))
		decoder.UseNumber()
		var value any
		if err := decoder.Decode(&value); err != nil {
			t.Fatalf("decode %s: %v", invalidPath, err)
		}
		if err := pairing.ValidateApprovalReceiptV1(value); err == nil {
			t.Errorf("accepted invalid approval receipt %s", filepath.Base(invalidPath))
		}
	}
}
