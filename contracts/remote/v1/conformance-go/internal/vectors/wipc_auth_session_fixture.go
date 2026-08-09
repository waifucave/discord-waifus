package vectors

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/wipc"
)

type AuthSessionParent struct {
	ClientNonceB64 string `json:"clientNonceB64"`
	HelloBytesB64  string `json:"helloBytesB64"`
}

type AuthSessionCandidate struct {
	ClientNonceB64          string `json:"clientNonceB64,omitempty"`
	HelloBytesB64           string `json:"helloBytesB64,omitempty"`
	HelperNonceB64          string `json:"helperNonceB64"`
	HelloAckBytesB64        string `json:"helloAckBytesB64"`
	ParentProofB64          string `json:"parentProofB64"`
	HelperProofB64          string `json:"helperProofB64,omitempty"`
	ExpectedParentOutcome   string `json:"expectedParentOutcome,omitempty"`
	ExpectedHelperOutcome   string `json:"expectedHelperOutcome,omitempty"`
	ExpectedParentError     string `json:"expectedParentError,omitempty"`
	ExpectedHelperError     string `json:"expectedHelperError,omitempty"`
	ExpectedCapabilityState string `json:"expectedCapabilityState"`
}

type AuthSessionCandidates struct {
	Valid                  AuthSessionCandidate `json:"valid"`
	Replacement            AuthSessionCandidate `json:"replacement"`
	WrongHelperProof       AuthSessionCandidate `json:"wrongHelperProof"`
	ReflectedParentProof   AuthSessionCandidate `json:"reflectedParentProof"`
	SocketRaceImpersonator AuthSessionCandidate `json:"socketRaceImpersonator"`
	ReplayedParentProof    AuthSessionCandidate `json:"replayedParentProof"`
}

type AuthSessionRules struct {
	TrafficBeforeAuthenticationError string    `json:"trafficBeforeAuthenticationError"`
	CandidateAlreadyActiveError      string    `json:"candidateAlreadyActiveError"`
	CompletionWithoutCandidateError  string    `json:"completionWithoutCandidateError"`
	SecondClientError                string    `json:"secondClientError"`
	RecoveryOrder                    [2]string `json:"recoveryOrder"`
}

type WIPCAuthSessionV1Fixture struct {
	SchemaVersion       int                   `json:"schemaVersion"`
	ParentCapabilityB64 string                `json:"parentCapabilityB64"`
	Parent              AuthSessionParent     `json:"parent"`
	Candidates          AuthSessionCandidates `json:"candidates"`
	Rules               AuthSessionRules      `json:"rules"`
}

func (fixture WIPCAuthSessionV1Fixture) Candidate(name string) (AuthSessionCandidate, bool) {
	switch name {
	case "valid":
		return fixture.Candidates.Valid, true
	case "replacement":
		return fixture.Candidates.Replacement, true
	case "wrongHelperProof":
		return fixture.Candidates.WrongHelperProof, true
	case "reflectedParentProof":
		return fixture.Candidates.ReflectedParentProof, true
	case "socketRaceImpersonator":
		return fixture.Candidates.SocketRaceImpersonator, true
	case "replayedParentProof":
		return fixture.Candidates.ReplayedParentProof, true
	default:
		return AuthSessionCandidate{}, false
	}
}

func BuildWIPCAuthSessionV1Fixture() (WIPCAuthSessionV1Fixture, error) {
	capability := sequentialBytes(0x00)
	clientNonce := sequentialBytes(0x20)
	hello := []byte(`{"component":"discord_waifus","nonce":"client","protocol":{"major":1,"minor":0}}`)
	helperNonce := sequentialBytes(0x40)
	helloAck := []byte(`{"component":"ts_connect","nonce":"helper","protocol":{"major":1,"minor":0}}`)
	parentProof, err := wipc.ParentProof(capability, clientNonce, helperNonce, hello, helloAck)
	if err != nil {
		return WIPCAuthSessionV1Fixture{}, err
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
		return WIPCAuthSessionV1Fixture{}, err
	}

	replacementHelperNonce := sequentialBytes(0x60)
	replacementHelloAck := []byte(`{"component":"ts_connect","nonce":"replacement","protocol":{"major":1,"minor":0}}`)
	replacementParentProof, err := wipc.ParentProof(
		capability,
		clientNonce,
		replacementHelperNonce,
		hello,
		replacementHelloAck,
	)
	if err != nil {
		return WIPCAuthSessionV1Fixture{}, err
	}
	replacementHelperProof, err := wipc.HelperProof(
		capability,
		clientNonce,
		replacementHelperNonce,
		hello,
		replacementHelloAck,
		replacementParentProof,
	)
	if err != nil {
		return WIPCAuthSessionV1Fixture{}, err
	}

	socketRaceHelperNonce := bytes.Repeat([]byte{0x7f}, 32)
	socketRaceHelloAck := []byte(`{"component":"ts_connect","nonce":"socket-race","protocol":{"major":1,"minor":0}}`)
	socketRaceParentProof, err := wipc.ParentProof(
		capability,
		clientNonce,
		socketRaceHelperNonce,
		hello,
		socketRaceHelloAck,
	)
	if err != nil {
		return WIPCAuthSessionV1Fixture{}, err
	}
	replayClientNonce := append([]byte(nil), clientNonce...)
	replayClientNonce[0] ^= 1
	replayHello := append(append([]byte(nil), hello...), ' ')
	wrongHelperProof := bytes.Repeat([]byte{0xff}, 32)
	encode := base64.RawURLEncoding.EncodeToString

	return WIPCAuthSessionV1Fixture{
		SchemaVersion:       1,
		ParentCapabilityB64: encode(capability),
		Parent: AuthSessionParent{
			ClientNonceB64: encode(clientNonce),
			HelloBytesB64:  encode(hello),
		},
		Candidates: AuthSessionCandidates{
			Valid: AuthSessionCandidate{
				HelperNonceB64:          encode(helperNonce),
				HelloAckBytesB64:        encode(helloAck),
				ParentProofB64:          encode(parentProof),
				HelperProofB64:          encode(helperProof),
				ExpectedParentOutcome:   "authenticated",
				ExpectedHelperOutcome:   "authenticated",
				ExpectedCapabilityState: "erased",
			},
			Replacement: AuthSessionCandidate{
				HelperNonceB64:          encode(replacementHelperNonce),
				HelloAckBytesB64:        encode(replacementHelloAck),
				ParentProofB64:          encode(replacementParentProof),
				HelperProofB64:          encode(replacementHelperProof),
				ExpectedParentOutcome:   "authenticated",
				ExpectedHelperOutcome:   "authenticated",
				ExpectedCapabilityState: "erased",
			},
			WrongHelperProof: AuthSessionCandidate{
				HelperNonceB64:          encode(helperNonce),
				HelloAckBytesB64:        encode(helloAck),
				ParentProofB64:          encode(parentProof),
				HelperProofB64:          encode(wrongHelperProof),
				ExpectedParentError:     "invalid_helper_proof",
				ExpectedCapabilityState: "retained",
			},
			ReflectedParentProof: AuthSessionCandidate{
				HelperNonceB64:          encode(helperNonce),
				HelloAckBytesB64:        encode(helloAck),
				ParentProofB64:          encode(parentProof),
				HelperProofB64:          encode(parentProof),
				ExpectedParentError:     "invalid_helper_proof",
				ExpectedCapabilityState: "retained",
			},
			SocketRaceImpersonator: AuthSessionCandidate{
				HelperNonceB64:          encode(socketRaceHelperNonce),
				HelloAckBytesB64:        encode(socketRaceHelloAck),
				ParentProofB64:          encode(socketRaceParentProof),
				HelperProofB64:          encode(socketRaceParentProof),
				ExpectedParentError:     "invalid_helper_proof",
				ExpectedCapabilityState: "retained",
			},
			ReplayedParentProof: AuthSessionCandidate{
				ClientNonceB64:          encode(replayClientNonce),
				HelloBytesB64:           encode(replayHello),
				HelperNonceB64:          encode(helperNonce),
				HelloAckBytesB64:        encode(helloAck),
				ParentProofB64:          encode(parentProof),
				ExpectedHelperError:     "invalid_parent_proof",
				ExpectedCapabilityState: "retained",
			},
		},
		Rules: AuthSessionRules{
			TrafficBeforeAuthenticationError: "frame_before_authentication",
			CandidateAlreadyActiveError:      "auth_sequence_error",
			CompletionWithoutCandidateError:  "auth_sequence_error",
			SecondClientError:                "auth_capability_unavailable",
			RecoveryOrder:                    [2]string{"socketRaceImpersonator", "replacement"},
		},
	}, nil
}

func BuildWIPCAuthSessionV1JSON() ([]byte, error) {
	fixture, err := BuildWIPCAuthSessionV1Fixture()
	if err != nil {
		return nil, err
	}
	return canonicalJSON(fixture)
}

func DecodeWIPCAuthSessionV1Fixture(encoded []byte) (WIPCAuthSessionV1Fixture, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var fixture WIPCAuthSessionV1Fixture
	if err := decoder.Decode(&fixture); err != nil {
		return WIPCAuthSessionV1Fixture{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return WIPCAuthSessionV1Fixture{}, fmt.Errorf("unexpected trailing JSON value")
		}
		return WIPCAuthSessionV1Fixture{}, fmt.Errorf("read trailing JSON: %w", err)
	}
	return fixture, nil
}
