package conformance_test

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/vectors"
	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/wipc"
)

func authSessionFixtureBytes(t *testing.T) []byte {
	t.Helper()
	value, err := os.ReadFile(filepath.Join("..", "..", "fixtures", "crypto", "wipc-auth-session-v1.json"))
	if err != nil {
		t.Fatalf("read committed WIPC auth-session fixture: %v", err)
	}
	return value
}

func TestGoGeneratorMatchesCommittedWIPCAuthSessionV1Fixture(t *testing.T) {
	expected, err := vectors.BuildWIPCAuthSessionV1JSON()
	if err != nil {
		t.Fatalf("build WIPC auth-session fixture: %v", err)
	}
	if !bytes.Equal(authSessionFixtureBytes(t), expected) {
		t.Fatalf("Go-generated WIPC auth-session fixture differs from committed bytes")
	}
}

func newParentSessionFromFixture(
	t *testing.T,
	fixture vectors.WIPCAuthSessionV1Fixture,
) *wipc.ParentAuthSession {
	t.Helper()
	session, err := wipc.NewParentAuthSession(
		decodeBase64URL(t, fixture.ParentCapabilityB64),
		decodeBase64URL(t, fixture.Parent.ClientNonceB64),
		decodeBase64URL(t, fixture.Parent.HelloBytesB64),
	)
	if err != nil {
		t.Fatalf("new parent auth session: %v", err)
	}
	return session
}

func newHelperSessionFromFixture(
	t *testing.T,
	fixture vectors.WIPCAuthSessionV1Fixture,
) *wipc.HelperAuthSession {
	t.Helper()
	session, err := wipc.NewHelperAuthSession(decodeBase64URL(t, fixture.ParentCapabilityB64))
	if err != nil {
		t.Fatalf("new helper auth session: %v", err)
	}
	return session
}

func TestWIPCAuthSessionFixture(t *testing.T) {
	fixture, err := vectors.DecodeWIPCAuthSessionV1Fixture(authSessionFixtureBytes(t))
	if err != nil {
		t.Fatalf("decode auth-session fixture: %v", err)
	}

	valid, ok := fixture.Candidate("valid")
	if !ok {
		t.Fatalf("valid candidate is missing")
	}
	parent := newParentSessionFromFixture(t, fixture)
	helper := newHelperSessionFromFixture(t, fixture)
	if err := parent.AssertTrafficAllowed(); protocolErrorCode(t, err) != fixture.Rules.TrafficBeforeAuthenticationError {
		t.Fatalf("unexpected pre-auth parent error: %v", err)
	}
	parentProof, err := parent.BeginCandidate(
		decodeBase64URL(t, valid.HelperNonceB64),
		decodeBase64URL(t, valid.HelloAckBytesB64),
	)
	if err != nil {
		t.Fatalf("begin valid candidate: %v", err)
	}
	if !bytes.Equal(parentProof, decodeBase64URL(t, valid.ParentProofB64)) {
		t.Fatalf("valid parent proof differs from fixture")
	}
	helperProof, err := helper.AuthenticateCandidate(wipc.HelperCandidate{
		ClientNonce: decodeBase64URL(t, fixture.Parent.ClientNonceB64),
		HelperNonce: decodeBase64URL(t, valid.HelperNonceB64),
		Hello:       decodeBase64URL(t, fixture.Parent.HelloBytesB64),
		HelloAck:    decodeBase64URL(t, valid.HelloAckBytesB64),
		ParentProof: parentProof,
	})
	if err != nil {
		t.Fatalf("authenticate valid helper: %v", err)
	}
	if !bytes.Equal(helperProof, decodeBase64URL(t, valid.HelperProofB64)) {
		t.Fatalf("valid helper proof differs from fixture")
	}
	if err := parent.CompleteCandidate(helperProof); err != nil {
		t.Fatalf("complete valid parent: %v", err)
	}
	if !parent.Authenticated() || !helper.Authenticated() {
		t.Fatalf("valid sessions did not authenticate")
	}
	if parent.CapabilityAvailable() || helper.CapabilityAvailable() {
		t.Fatalf("successful sessions retained a capability")
	}
	if err := parent.AssertTrafficAllowed(); err != nil {
		t.Fatalf("authenticated parent blocked traffic: %v", err)
	}

	for _, name := range []string{"wrongHelperProof", "reflectedParentProof"} {
		candidate, ok := fixture.Candidate(name)
		if !ok {
			t.Fatalf("candidate %q is missing", name)
		}
		parent := newParentSessionFromFixture(t, fixture)
		if _, err := parent.BeginCandidate(
			decodeBase64URL(t, candidate.HelperNonceB64),
			decodeBase64URL(t, candidate.HelloAckBytesB64),
		); err != nil {
			t.Fatalf("begin %s: %v", name, err)
		}
		err := parent.CompleteCandidate(decodeBase64URL(t, candidate.HelperProofB64))
		if got := protocolErrorCode(t, err); got != candidate.ExpectedParentError {
			t.Fatalf("%s error = %q, want %q", name, got, candidate.ExpectedParentError)
		}
		if !parent.CapabilityAvailable() || parent.Authenticated() {
			t.Fatalf("%s consumed capability or authenticated", name)
		}
	}

	replay, ok := fixture.Candidate("replayedParentProof")
	if !ok {
		t.Fatalf("replayed parent candidate is missing")
	}
	replayHelper := newHelperSessionFromFixture(t, fixture)
	_, err = replayHelper.AuthenticateCandidate(wipc.HelperCandidate{
		ClientNonce: decodeBase64URL(t, replay.ClientNonceB64),
		HelperNonce: decodeBase64URL(t, replay.HelperNonceB64),
		Hello:       decodeBase64URL(t, replay.HelloBytesB64),
		HelloAck:    decodeBase64URL(t, replay.HelloAckBytesB64),
		ParentProof: decodeBase64URL(t, replay.ParentProofB64),
	})
	if got := protocolErrorCode(t, err); got != replay.ExpectedHelperError {
		t.Fatalf("replay error = %q, want %q", got, replay.ExpectedHelperError)
	}
	if !replayHelper.CapabilityAvailable() {
		t.Fatalf("replayed parent proof consumed helper capability")
	}
}

func TestWIPCAuthSessionSocketRaceRecoveryAndSecondClient(t *testing.T) {
	fixture, err := vectors.DecodeWIPCAuthSessionV1Fixture(authSessionFixtureBytes(t))
	if err != nil {
		t.Fatalf("decode auth-session fixture: %v", err)
	}
	race, ok := fixture.Candidate(fixture.Rules.RecoveryOrder[0])
	if !ok {
		t.Fatalf("race candidate is missing")
	}
	recovery, ok := fixture.Candidate(fixture.Rules.RecoveryOrder[1])
	if !ok {
		t.Fatalf("recovery candidate is missing")
	}
	parent := newParentSessionFromFixture(t, fixture)
	if _, err := parent.BeginCandidate(
		decodeBase64URL(t, race.HelperNonceB64),
		decodeBase64URL(t, race.HelloAckBytesB64),
	); err != nil {
		t.Fatalf("begin race candidate: %v", err)
	}
	err = parent.CompleteCandidate(decodeBase64URL(t, race.HelperProofB64))
	if got := protocolErrorCode(t, err); got != race.ExpectedParentError {
		t.Fatalf("race error = %q, want %q", got, race.ExpectedParentError)
	}

	helper := newHelperSessionFromFixture(t, fixture)
	parentProof, err := parent.BeginCandidate(
		decodeBase64URL(t, recovery.HelperNonceB64),
		decodeBase64URL(t, recovery.HelloAckBytesB64),
	)
	if err != nil {
		t.Fatalf("begin recovery: %v", err)
	}
	helperProof, err := helper.AuthenticateCandidate(wipc.HelperCandidate{
		ClientNonce: decodeBase64URL(t, fixture.Parent.ClientNonceB64),
		HelperNonce: decodeBase64URL(t, recovery.HelperNonceB64),
		Hello:       decodeBase64URL(t, fixture.Parent.HelloBytesB64),
		HelloAck:    decodeBase64URL(t, recovery.HelloAckBytesB64),
		ParentProof: parentProof,
	})
	if err != nil {
		t.Fatalf("helper recovery: %v", err)
	}
	if err := parent.CompleteCandidate(helperProof); err != nil {
		t.Fatalf("parent recovery: %v", err)
	}

	_, err = parent.BeginCandidate(
		decodeBase64URL(t, recovery.HelperNonceB64),
		decodeBase64URL(t, recovery.HelloAckBytesB64),
	)
	if got := protocolErrorCode(t, err); got != fixture.Rules.SecondClientError {
		t.Fatalf("parent second-client error = %q, want %q", got, fixture.Rules.SecondClientError)
	}
	_, err = helper.AuthenticateCandidate(wipc.HelperCandidate{
		ClientNonce: decodeBase64URL(t, fixture.Parent.ClientNonceB64),
		HelperNonce: decodeBase64URL(t, recovery.HelperNonceB64),
		Hello:       decodeBase64URL(t, fixture.Parent.HelloBytesB64),
		HelloAck:    decodeBase64URL(t, recovery.HelloAckBytesB64),
		ParentProof: parentProof,
	})
	if got := protocolErrorCode(t, err); got != fixture.Rules.SecondClientError {
		t.Fatalf("helper second-client error = %q, want %q", got, fixture.Rules.SecondClientError)
	}
}

func TestWIPCAuthSessionSequenceErrors(t *testing.T) {
	fixture, err := vectors.DecodeWIPCAuthSessionV1Fixture(authSessionFixtureBytes(t))
	if err != nil {
		t.Fatalf("decode auth-session fixture: %v", err)
	}
	valid, ok := fixture.Candidate("valid")
	if !ok {
		t.Fatalf("valid candidate is missing")
	}
	parent := newParentSessionFromFixture(t, fixture)
	err = parent.CompleteCandidate(make([]byte, 32))
	if got := protocolErrorCode(t, err); got != fixture.Rules.CompletionWithoutCandidateError {
		t.Fatalf("completion error = %q, want %q", got, fixture.Rules.CompletionWithoutCandidateError)
	}
	if _, err := parent.BeginCandidate(
		decodeBase64URL(t, valid.HelperNonceB64),
		decodeBase64URL(t, valid.HelloAckBytesB64),
	); err != nil {
		t.Fatalf("begin first candidate: %v", err)
	}
	_, err = parent.BeginCandidate(
		decodeBase64URL(t, valid.HelperNonceB64),
		decodeBase64URL(t, valid.HelloAckBytesB64),
	)
	if got := protocolErrorCode(t, err); got != fixture.Rules.CandidateAlreadyActiveError {
		t.Fatalf("duplicate candidate error = %q, want %q", got, fixture.Rules.CandidateAlreadyActiveError)
	}
	if !parent.CapabilityAvailable() {
		t.Fatalf("sequence error consumed parent capability")
	}

	helper := newHelperSessionFromFixture(t, fixture)
	err = helper.AssertTrafficAllowed()
	if got := protocolErrorCode(t, err); got != fixture.Rules.TrafficBeforeAuthenticationError {
		t.Fatalf("helper traffic error = %q, want %q", got, fixture.Rules.TrafficBeforeAuthenticationError)
	}
}
