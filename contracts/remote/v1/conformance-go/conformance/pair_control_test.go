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

type controlRecordVector struct {
	Name              string                       `json:"name"`
	TypeByte          int                          `json:"typeByte"`
	IngressTransport  pairing.PairControlTransport `json:"ingressTransport"`
	Value             pairing.PairControlRecord    `json:"value"`
	CanonicalBytesB64 string                       `json:"canonicalBytesB64"`
	PayloadBytesB64   string                       `json:"payloadBytesB64"`
	SignatureInputB64 string                       `json:"signatureInputB64"`
}

type controlRejectionVector struct {
	Name         string                       `json:"name"`
	PayloadB64   string                       `json:"payloadB64"`
	ErrorCode    string                       `json:"errorCode"`
	Side         int                          `json:"side"`
	KeySide      int                          `json:"keySide"`
	ExpectedSide int                          `json:"expectedSide"`
	Transport    pairing.PairControlTransport `json:"transport"`
}

type revocationRejectionVector struct {
	Name    string                         `json:"name"`
	Value   pairing.PairControlRecord      `json:"value"`
	KeyB64  string                         `json:"keyB64"`
	Context *pairing.PairRevocationContext `json:"context"`
}

type pairControlFixture struct {
	AcceptedAt             string `json:"acceptedAt"`
	DelayedAt              string `json:"delayedAt"`
	InstallationPublicKeys struct {
		Host   string `json:"host"`
		Remote string `json:"remote"`
	} `json:"installationPublicKeys"`
	Context struct {
		PairID string `json:"pairId"`
	} `json:"context"`
	Records              []controlRecordVector    `json:"records"`
	Rejections           []controlRejectionVector `json:"rejections"`
	StateRejections      []controlRejectionVector `json:"stateRejections"`
	GenerationTransition struct {
		AdvancePayloadB64 string `json:"advancePayloadB64"`
		StalePayloadB64   string `json:"stalePayloadB64"`
	} `json:"generationTransition"`
	Boundary struct {
		MaximumRecordBytes  int    `json:"maximumRecordBytes"`
		MaximumRecordB64    string `json:"maximumRecordB64"`
		OverLimitPayloadB64 string `json:"overLimitPayloadB64"`
	} `json:"boundary"`
	Revocation struct {
		RevocationKeyB64         string                        `json:"revocationKeyB64"`
		Context                  pairing.PairRevocationContext `json:"context"`
		RevocationMACInputB64    string                        `json:"revocationMacInputB64"`
		RevocationAckMACInputB64 string                        `json:"revocationAckMacInputB64"`
		Rejections               []revocationRejectionVector   `json:"rejections"`
		WorkerOpaqueWrongMAC     controlRecordVector           `json:"workerOpaqueWrongMac"`
	} `json:"revocation"`
}

func pairControlFixtureBytes(t *testing.T) []byte {
	t.Helper()
	value, err := os.ReadFile(filepath.Join("..", "..", "fixtures", "crypto", "pair-control-record-v1.json"))
	if err != nil {
		t.Fatalf("read committed pair control fixture: %v", err)
	}
	return value
}

func decodePairControlFixture(t *testing.T) pairControlFixture {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(pairControlFixtureBytes(t)))
	decoder.UseNumber()
	var fixture pairControlFixture
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("decode pair control fixture: %v", err)
	}
	return fixture
}

func controlErrorCode(t *testing.T, err error) string {
	t.Helper()
	var protocolError *pairing.ControlError
	if !errors.As(err, &protocolError) {
		t.Fatalf("expected ControlError, got %T: %v", err, err)
	}
	return protocolError.Code
}

func fixtureSeconds(t *testing.T, value string) uint64 {
	t.Helper()
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		t.Fatalf("parse fixture timestamp: %v", err)
	}
	return parsed
}

func controlPublicKey(t *testing.T, fixture pairControlFixture, side int) []byte {
	t.Helper()
	if side == 1 {
		return decodeBase64URL(t, fixture.InstallationPublicKeys.Host)
	}
	return decodeBase64URL(t, fixture.InstallationPublicKeys.Remote)
}

func controlVerifyOptions(t *testing.T, fixture pairControlFixture, vector controlRecordVector) pairing.PairControlVerifyOptions {
	t.Helper()
	return pairing.PairControlVerifyOptions{
		InstallationPublicKey: controlPublicKey(t, fixture, vector.Value.Side),
		ExpectedPairID:        fixture.Context.PairID,
		ExpectedSide:          vector.Value.Side,
		NowSeconds:            fixtureSeconds(t, fixture.AcceptedAt),
		TimestampMode:         pairing.ControlWorkerIngress,
		Transport:             vector.IngressTransport,
		ExpectedProtocolMajor: 1,
		ExpectedProtocolMinor: 0,
	}
}

func TestGoGeneratorMatchesCommittedPairControlFixture(t *testing.T) {
	expected, err := vectors.BuildPairControlV1JSON()
	if err != nil {
		t.Fatalf("build pair control fixture: %v", err)
	}
	if !bytes.Equal(expected, pairControlFixtureBytes(t)) {
		t.Fatalf("Go-generated pair control fixture differs from committed bytes")
	}
}

func TestPairControlValidRecordsAndSignatureInputs(t *testing.T) {
	fixture := decodePairControlFixture(t)
	if len(fixture.Records) != 9 {
		t.Fatalf("record count = %d, want 9", len(fixture.Records))
	}
	for index, vector := range fixture.Records {
		if vector.TypeByte != index+1 {
			t.Fatalf("record %d type = %d", index, vector.TypeByte)
		}
		t.Run(vector.Name, func(t *testing.T) {
			payload := decodeBase64URL(t, vector.CanonicalBytesB64)
			parsed, err := pairing.ParseAndVerifyPairControlRecord(payload, controlVerifyOptions(t, fixture, vector))
			if err != nil {
				t.Fatalf("parse valid control record: %v", err)
			}
			if !reflect.DeepEqual(parsed, vector.Value) {
				t.Fatalf("parsed record differs from fixture")
			}
			canonical, err := pairing.CanonicalPairControlJSON(parsed)
			if err != nil || !bytes.Equal(canonical, payload) {
				t.Fatalf("canonical bytes differ: %v", err)
			}
			payloadBytes, err := pairing.PairControlPayloadJSON(parsed)
			if err != nil || !bytes.Equal(payloadBytes, decodeBase64URL(t, vector.PayloadBytesB64)) {
				t.Fatalf("payload bytes differ: %v", err)
			}
			signatureInput, err := pairing.PairControlSignatureInput(parsed)
			if err != nil || !bytes.Equal(signatureInput, decodeBase64URL(t, vector.SignatureInputB64)) {
				t.Fatalf("signature input differs: %v", err)
			}
		})
	}
}

func TestPairControlRejectionsAndBoundary(t *testing.T) {
	fixture := decodePairControlFixture(t)
	for _, vector := range fixture.Rejections {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			keySide := vector.KeySide
			if keySide == 0 {
				keySide = vector.Side
			}
			if keySide == 0 {
				keySide = 1
			}
			expectedSide := vector.ExpectedSide
			if expectedSide == 0 {
				expectedSide = vector.Side
			}
			if expectedSide == 0 {
				expectedSide = 1
			}
			transport := vector.Transport
			if transport == "" {
				transport = pairing.ControlHTTPSPublish
			}
			_, err := pairing.ParseAndVerifyPairControlRecord(
				decodeBase64URL(t, vector.PayloadB64),
				pairing.PairControlVerifyOptions{
					InstallationPublicKey: controlPublicKey(t, fixture, keySide),
					ExpectedPairID:        fixture.Context.PairID, ExpectedSide: expectedSide,
					NowSeconds: fixtureSeconds(t, fixture.AcceptedAt), TimestampMode: pairing.ControlWorkerIngress,
					Transport: transport, ExpectedProtocolMajor: 1, ExpectedProtocolMinor: 0,
				},
			)
			if err == nil || controlErrorCode(t, err) != vector.ErrorCode {
				t.Fatalf("error = %v, want %s", err, vector.ErrorCode)
			}
		})
	}
	maximum := decodeBase64URL(t, fixture.Boundary.MaximumRecordB64)
	if len(maximum) != fixture.Boundary.MaximumRecordBytes || len(maximum) > pairing.PairControlRecordMax {
		t.Fatalf("maximum record boundary differs: %d", len(maximum))
	}
	_, err := pairing.ParseAndVerifyPairControlRecord(maximum, pairing.PairControlVerifyOptions{
		InstallationPublicKey: controlPublicKey(t, fixture, 1), ExpectedPairID: fixture.Context.PairID, ExpectedSide: 1,
		NowSeconds: fixtureSeconds(t, fixture.AcceptedAt), TimestampMode: pairing.ControlWorkerIngress,
		Transport: pairing.ControlWebSocket, ExpectedProtocolMajor: 1, ExpectedProtocolMinor: 0,
	})
	if err != nil {
		t.Fatalf("maximum record rejected: %v", err)
	}
	_, err = pairing.ParseAndVerifyPairControlRecord(
		decodeBase64URL(t, fixture.Boundary.OverLimitPayloadB64),
		controlVerifyOptions(t, fixture, fixture.Records[0]),
	)
	if err == nil || controlErrorCode(t, err) != "payload_too_large" {
		t.Fatalf("over-limit record outcome = %v", err)
	}
}

func TestPairControlTransportMatrix(t *testing.T) {
	expected := map[pairing.PairControlTransport][]int{
		pairing.ControlWebSocket:      {1, 2, 3, 4, 5, 6, 7, 8, 9},
		pairing.ControlHTTPSPublish:   {1, 2, 3, 4, 5, 6, 9},
		pairing.ControlHTTPSRevoke:    {7},
		pairing.ControlHTTPSRevokeAck: {8},
		pairing.ControlHTTPSPoll:      {1, 2, 3, 4, 5, 6, 7, 8, 9},
	}
	for transport, allowed := range expected {
		for typeValue := 1; typeValue <= 9; typeValue++ {
			want := false
			for _, candidate := range allowed {
				want = want || candidate == typeValue
			}
			if pairing.PairControlTransportAllows(transport, typeValue) != want {
				t.Fatalf("transport %s type %d differs", transport, typeValue)
			}
		}
	}
}

func TestPairControlSharedHighWaterRestartAndGeneration(t *testing.T) {
	fixture := decodePairControlFixture(t)
	state, err := pairing.NewPairControlIngress(
		fixture.Context.PairID,
		controlPublicKey(t, fixture, 1),
		controlPublicKey(t, fixture, 2),
		nil,
	)
	if err != nil {
		t.Fatalf("create ingress state: %v", err)
	}
	now := fixtureSeconds(t, fixture.AcceptedAt)
	for _, vector := range fixture.Records[:6] {
		outcome, err := state.Accept(decodeBase64URL(t, vector.CanonicalBytesB64), vector.IngressTransport, now)
		if err != nil || outcome != "accepted" {
			t.Fatalf("accept %s: outcome=%s err=%v", vector.Name, outcome, err)
		}
	}
	revocation := fixture.Records[6]
	if _, err := state.Accept(decodeBase64URL(t, revocation.CanonicalBytesB64), pairing.ControlHTTPSPublish, now); err == nil || controlErrorCode(t, err) != "wrong_transport" {
		t.Fatalf("wrong-route revocation outcome = %v", err)
	}
	if outcome, err := state.Accept(decodeBase64URL(t, revocation.CanonicalBytesB64), pairing.ControlHTTPSRevoke, now); err != nil || outcome != "accepted" {
		t.Fatalf("accept revocation after wrong route: outcome=%s err=%v", outcome, err)
	}
	ack := fixture.Records[7]
	if outcome, err := state.Accept(decodeBase64URL(t, ack.CanonicalBytesB64), pairing.ControlHTTPSRevokeAck, now); err != nil || outcome != "accepted" {
		t.Fatalf("accept revocation ack: outcome=%s err=%v", outcome, err)
	}
	snapshot := state.Snapshot()
	state, err = pairing.NewPairControlIngress(
		fixture.Context.PairID,
		controlPublicKey(t, fixture, 1),
		controlPublicKey(t, fixture, 2),
		&snapshot,
	)
	if err != nil {
		t.Fatalf("restore ingress state: %v", err)
	}
	errorVector := fixture.Records[8]
	errorBytes := decodeBase64URL(t, errorVector.CanonicalBytesB64)
	if outcome, err := state.Accept(errorBytes, pairing.ControlHTTPSPublish, now); err != nil || outcome != "accepted" {
		t.Fatalf("accept post-restart error: outcome=%s err=%v", outcome, err)
	}
	if outcome, err := state.Accept(errorBytes, pairing.ControlWebSocket, now); err != nil || outcome != "idempotent" {
		t.Fatalf("cross-transport retry: outcome=%s err=%v", outcome, err)
	}
	for _, vector := range fixture.StateRejections {
		if _, err := state.Accept(decodeBase64URL(t, vector.PayloadB64), vector.Transport, now); err == nil || controlErrorCode(t, err) != vector.ErrorCode {
			t.Fatalf("state rejection %s = %v", vector.Name, err)
		}
	}
	advance := decodeBase64URL(t, fixture.GenerationTransition.AdvancePayloadB64)
	if outcome, err := state.Accept(advance, pairing.ControlWebSocket, now); err != nil || outcome != "accepted" {
		t.Fatalf("advance generation: outcome=%s err=%v", outcome, err)
	}
	if outcome, err := state.Accept(advance, pairing.ControlHTTPSPublish, now); err != nil || outcome != "idempotent" {
		t.Fatalf("retry generation advance: outcome=%s err=%v", outcome, err)
	}
	if _, err := state.Accept(decodeBase64URL(t, fixture.GenerationTransition.StalePayloadB64), pairing.ControlWebSocket, now); err == nil || controlErrorCode(t, err) != "stale_generation" {
		t.Fatalf("stale generation outcome = %v", err)
	}
}

func TestPairControlDelayedDeliveryAndRevocationMACs(t *testing.T) {
	fixture := decodePairControlFixture(t)
	delayedAt := fixtureSeconds(t, fixture.DelayedAt)
	capabilities := fixture.Records[1]
	capabilitiesBytes := decodeBase64URL(t, capabilities.CanonicalBytesB64)
	options := controlVerifyOptions(t, fixture, capabilities)
	options.NowSeconds = delayedAt
	if _, err := pairing.ParseAndVerifyPairControlRecord(capabilitiesBytes, options); err == nil || controlErrorCode(t, err) != "timestamp_out_of_window" {
		t.Fatalf("old first-ingress record outcome = %v", err)
	}
	options.TimestampMode = pairing.ControlDurableDelivery
	options.Transport = pairing.ControlHTTPSPoll
	if _, err := pairing.ParseAndVerifyPairControlRecord(capabilitiesBytes, options); err != nil {
		t.Fatalf("delayed durable record rejected: %v", err)
	}
	presence := fixture.Records[4]
	presenceOptions := controlVerifyOptions(t, fixture, presence)
	presenceOptions.NowSeconds = delayedAt
	presenceOptions.TimestampMode = pairing.ControlDurableDelivery
	presenceOptions.Transport = pairing.ControlHTTPSPoll
	if _, err := pairing.ParseAndVerifyPairControlRecord(decodeBase64URL(t, presence.CanonicalBytesB64), presenceOptions); err == nil || controlErrorCode(t, err) != "presence_expired" {
		t.Fatalf("expired presence outcome = %v", err)
	}

	key := decodeBase64URL(t, fixture.Revocation.RevocationKeyB64)
	revocation := fixture.Records[6].Value
	ack := fixture.Records[7].Value
	if !pairing.VerifyPairRevocationMAC(key, revocation, fixture.Revocation.Context) || !pairing.VerifyPairRevocationMAC(key, ack, fixture.Revocation.Context) {
		t.Fatalf("valid revocation MACs were rejected")
	}
	revocationInput, err := pairing.PairRevocationMACInput(revocation, fixture.Revocation.Context)
	if err != nil || !bytes.Equal(revocationInput, decodeBase64URL(t, fixture.Revocation.RevocationMACInputB64)) {
		t.Fatalf("revocation MAC input differs: %v", err)
	}
	ackInput, err := pairing.PairRevocationAckMACInput(ack, fixture.Revocation.Context)
	if err != nil || !bytes.Equal(ackInput, decodeBase64URL(t, fixture.Revocation.RevocationAckMACInputB64)) {
		t.Fatalf("revocation ack MAC input differs: %v", err)
	}
	for _, vector := range fixture.Revocation.Rejections {
		vectorKey := key
		if vector.KeyB64 != "" {
			vectorKey = decodeBase64URL(t, vector.KeyB64)
		}
		context := fixture.Revocation.Context
		if vector.Context != nil {
			context = *vector.Context
		}
		if pairing.VerifyPairRevocationMAC(vectorKey, vector.Value, context) {
			t.Fatalf("revocation rejection %s was accepted", vector.Name)
		}
	}
	wrongMAC := fixture.Revocation.WorkerOpaqueWrongMAC
	workerOptions := controlVerifyOptions(t, fixture, wrongMAC)
	wrongMACBytes := decodeBase64URL(t, wrongMAC.CanonicalBytesB64)
	if _, err := pairing.ParseAndVerifyPairControlRecord(wrongMACBytes, workerOptions); err != nil {
		t.Fatalf("Worker-style opaque MAC validation rejected record: %v", err)
	}
	workerOptions.RevocationKey = key
	workerOptions.RevocationContext = &fixture.Revocation.Context
	if _, err := pairing.ParseAndVerifyPairControlRecord(wrongMACBytes, workerOptions); err == nil || controlErrorCode(t, err) != "invalid_revocation_mac" {
		t.Fatalf("helper-style wrong MAC outcome = %v", err)
	}
}
