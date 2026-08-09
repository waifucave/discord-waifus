package conformance_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/vectors"
)

type pairingRejection struct {
	Name          string `json:"name"`
	Encoded       string `json:"encoded"`
	Now           string `json:"now"`
	CBORB64       string `json:"cborB64"`
	BundleCBORB64 string `json:"bundleCborB64"`
	Handshake     string `json:"handshake"`
	Target        string `json:"target"`
	ByteIndex     int    `json:"byteIndex"`
	XOR           byte   `json:"xor"`
}

type pairingHandshakeVector struct {
	Name        string   `json:"name"`
	MessagesB64 []string `json:"messagesB64"`
	Inputs      struct {
		PrologueB64                     string   `json:"prologueB64"`
		PSKB64                          *string  `json:"pskB64"`
		InitiatorStaticPrivateKeyB64    string   `json:"initiatorStaticPrivateKeyB64"`
		ResponderStaticPrivateKeyB64    string   `json:"responderStaticPrivateKeyB64"`
		InitiatorEphemeralPrivateKeyB64 string   `json:"initiatorEphemeralPrivateKeyB64"`
		ResponderEphemeralPrivateKeyB64 string   `json:"responderEphemeralPrivateKeyB64"`
		PayloadsB64                     []string `json:"payloadsB64"`
	} `json:"inputs"`
	PairContext struct {
		HostContributionB64   string `json:"hostContributionB64"`
		RemoteContributionB64 string `json:"remoteContributionB64"`
	} `json:"pairContext"`
}

type pairingFixture struct {
	FullToken struct {
		Encoded    string `json:"encoded"`
		AcceptedAt string `json:"acceptedAt"`
	} `json:"fullToken"`
	Identities struct {
		Host struct {
			BundleCBORB64 string `json:"bundleCborB64"`
		} `json:"host"`
		Remote struct {
			BundleCBORB64 string `json:"bundleCborB64"`
		} `json:"remote"`
	} `json:"identities"`
	Handshakes []pairingHandshakeVector `json:"handshakes"`
	Rejections struct {
		CanonicalCBOR   []pairingRejection `json:"canonicalCbor"`
		Tokens          []pairingRejection `json:"tokens"`
		IdentityBundles []pairingRejection `json:"identityBundles"`
		Noise           []pairingRejection `json:"noise"`
	} `json:"rejections"`
}

func pairingFixtureBytes(t *testing.T) []byte {
	t.Helper()
	value, err := os.ReadFile(filepath.Join("..", "..", "fixtures", "crypto", "pairing-v1.json"))
	if err != nil {
		t.Fatalf("read committed pairing fixture: %v", err)
	}
	return value
}

func decodePairingFixture(t *testing.T) pairingFixture {
	t.Helper()
	var fixture pairingFixture
	if err := json.Unmarshal(pairingFixtureBytes(t), &fixture); err != nil {
		t.Fatalf("decode pairing fixture: %v", err)
	}
	return fixture
}

func TestGoGeneratorMatchesCommittedPairingV1Fixture(t *testing.T) {
	expected, err := vectors.BuildPairingV1JSON()
	if err != nil {
		t.Fatalf("build pairing fixture: %v", err)
	}
	if !bytes.Equal(pairingFixtureBytes(t), expected) {
		t.Fatalf("Go-generated pairing fixture differs from committed bytes")
	}
}

func TestPairingTokenAndIdentityAcceptance(t *testing.T) {
	fixture := decodePairingFixture(t)
	now, err := strconv.ParseUint(fixture.FullToken.AcceptedAt, 10, 64)
	if err != nil {
		t.Fatalf("parse acceptedAt: %v", err)
	}
	if _, err := pairing.DecodeFullToken(fixture.FullToken.Encoded, now); err != nil {
		t.Fatalf("decode valid full token: %v", err)
	}
	for name, encoded := range map[string]string{
		"host":   fixture.Identities.Host.BundleCBORB64,
		"remote": fixture.Identities.Remote.BundleCBORB64,
	} {
		if _, err := pairing.DecodeIdentity(decodeBase64URL(t, encoded)); err != nil {
			t.Fatalf("decode valid %s identity: %v", name, err)
		}
	}
}

func TestPairingRejectionVectors(t *testing.T) {
	fixture := decodePairingFixture(t)
	for _, vector := range fixture.Rejections.CanonicalCBOR {
		vector := vector
		t.Run("cbor/"+vector.Name, func(t *testing.T) {
			if _, err := pairing.DecodeCanonicalCBOR(decodeBase64URL(t, vector.CBORB64)); err == nil {
				t.Fatalf("invalid canonical CBOR was accepted")
			}
		})
	}
	for _, vector := range fixture.Rejections.Tokens {
		vector := vector
		t.Run("token/"+vector.Name, func(t *testing.T) {
			now, err := strconv.ParseUint(vector.Now, 10, 64)
			if err != nil {
				t.Fatalf("parse token now: %v", err)
			}
			if _, err := pairing.DecodeFullToken(vector.Encoded, now); err == nil {
				t.Fatalf("invalid full token was accepted")
			}
		})
	}
	for _, vector := range fixture.Rejections.IdentityBundles {
		vector := vector
		t.Run("identity/"+vector.Name, func(t *testing.T) {
			if _, err := pairing.DecodeIdentity(decodeBase64URL(t, vector.BundleCBORB64)); err == nil {
				t.Fatalf("invalid identity bundle was accepted")
			}
		})
	}
}

func TestPairDerivationRejectsSelfPairing(t *testing.T) {
	_, err := pairing.DerivePairKeys(
		pairing.Sequence(0x10, 32),
		pairing.Sequence(0x30, 32),
		pairing.Sequence(0x50, 32),
		pairing.Sequence(0x70, 16),
		1,
		pairing.Sequence(0x90, 16),
		pairing.Sequence(0xb0, 32),
		pairing.Sequence(0xd0, 32),
		pairing.Sequence(0x01, 32),
		pairing.Sequence(0x01, 32),
	)
	if err == nil {
		t.Fatalf("self-pair identity hashes were accepted")
	}
}

func TestNoiseSubstitutionVectors(t *testing.T) {
	fixture := decodePairingFixture(t)
	handshakes := make(map[string]pairingHandshakeVector, len(fixture.Handshakes))
	for _, handshake := range fixture.Handshakes {
		handshakes[handshake.Name] = handshake
	}
	for _, vector := range fixture.Rejections.Noise {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			handshake, ok := handshakes[vector.Handshake]
			if !ok {
				t.Fatalf("unknown handshake %q", vector.Handshake)
			}
			prologue := decodeBase64URL(t, handshake.Inputs.PrologueB64)
			var psk []byte
			if handshake.Inputs.PSKB64 != nil {
				psk = decodeBase64URL(t, *handshake.Inputs.PSKB64)
			}
			initiatorStatic := decodeBase64URL(t, handshake.Inputs.InitiatorStaticPrivateKeyB64)
			responderStatic := decodeBase64URL(t, handshake.Inputs.ResponderStaticPrivateKeyB64)
			initiatorEphemeral := decodeBase64URL(t, handshake.Inputs.InitiatorEphemeralPrivateKeyB64)
			responderEphemeral := decodeBase64URL(t, handshake.Inputs.ResponderEphemeralPrivateKeyB64)
			payloads := make([][]byte, len(handshake.Inputs.PayloadsB64))
			for index, encoded := range handshake.Inputs.PayloadsB64 {
				payloads[index] = decodeBase64URL(t, encoded)
			}
			messages := make([][]byte, len(handshake.MessagesB64))
			for index, encoded := range handshake.MessagesB64 {
				messages[index] = decodeBase64URL(t, encoded)
			}

			mutate := func(value []byte) {
				t.Helper()
				if vector.ByteIndex < 0 || vector.ByteIndex >= len(value) {
					t.Fatalf("mutation index %d outside %d-byte target", vector.ByteIndex, len(value))
				}
				value[vector.ByteIndex] ^= vector.XOR
			}
			switch vector.Target {
			case "prologue":
				mutate(prologue)
			case "psk":
				mutate(psk)
			case "initiatorStaticPrivateKey":
				mutate(initiatorStatic)
			case "responderStaticPrivateKey":
				mutate(responderStatic)
			case "payload1", "payload2", "payload3":
				mutate(payloads[int(vector.Target[len(vector.Target)-1]-'1')])
			case "message1", "message2", "message3":
				mutate(messages[int(vector.Target[len(vector.Target)-1]-'1')])
			case "addPsk":
				psk = make([]byte, 32)
				mutate(psk)
			default:
				t.Fatalf("unknown Noise mutation target %q", vector.Target)
			}

			result, err := pairing.RunNoiseXX(
				prologue,
				psk,
				initiatorStatic,
				responderStatic,
				initiatorEphemeral,
				responderEphemeral,
				payloads,
				decodeBase64URL(t, handshake.PairContext.RemoteContributionB64),
				decodeBase64URL(t, handshake.PairContext.HostContributionB64),
			)
			if err != nil {
				return
			}
			matches := len(result.Messages) == len(messages)
			if matches {
				for index := range result.Messages {
					matches = matches && bytes.Equal(result.Messages[index], messages[index])
				}
			}
			if matches {
				t.Fatalf("substituted Noise input/transcript was accepted byte-for-byte")
			}
		})
	}
}
