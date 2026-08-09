package vectors

import (
	"bytes"
	"encoding/hex"
	"fmt"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
)

func endpointContextMap(value pairing.EndpointContext) map[string]any {
	return map[string]any{
		"negotiatedMinor":                 int(value.NegotiatedMinor),
		"pairIdB64":                       pairing.B64(value.PairID),
		"senderRole":                      int(value.SenderRole),
		"receiverRole":                    int(value.ReceiverRole),
		"hostInstallationBundleHashB64":   pairing.B64(value.HostInstallationBundleHash),
		"remoteInstallationBundleHashB64": pairing.B64(value.RemoteInstallationBundleHash),
		"hostTrustEpoch":                  fmt.Sprintf("%d", value.HostTrustEpoch),
		"remoteTrustEpoch":                fmt.Sprintf("%d", value.RemoteTrustEpoch),
		"endpointEpoch":                   fmt.Sprintf("%d", value.EndpointEpoch),
	}
}

func endpointCandidateFixture(value pairing.EndpointCandidate) map[string]any {
	return map[string]any{
		"kind": int(value.Kind), "family": int(value.Family), "addressB64": pairing.B64(value.Address),
		"port": int(value.Port), "priority": int64(value.Priority),
	}
}

func endpointValueMap(value pairing.EndpointGeneration) map[string]any {
	candidates := make([]any, len(value.Candidates))
	for index, candidate := range value.Candidates {
		candidates[index] = endpointCandidateFixture(candidate)
	}
	return map[string]any{
		"version": 1, "endpointEpoch": fmt.Sprintf("%d", value.EndpointEpoch),
		"connectionGeneration": fmt.Sprintf("%d", value.ConnectionGeneration), "candidates": candidates,
	}
}

func endpointCloneContext(value pairing.EndpointContext) pairing.EndpointContext {
	value.PairID = append([]byte(nil), value.PairID...)
	value.HostInstallationBundleHash = append([]byte(nil), value.HostInstallationBundleHash...)
	value.RemoteInstallationBundleHash = append([]byte(nil), value.RemoteInstallationBundleHash...)
	return value
}

func endpointMutate(value []byte) []byte {
	result := append([]byte(nil), value...)
	result[0] ^= 1
	return result
}

func rawEndpointCandidate(overrides map[string]any) map[uint64]any {
	value := map[uint64]any{
		1: uint64(1), 2: uint64(4), 3: []byte{192, 168, 1, 10},
		4: uint64(41641), 5: uint64(100),
	}
	for key, candidate := range overrides {
		switch key {
		case "kind":
			value[1] = candidate
		case "family":
			value[2] = candidate
		case "address":
			value[3] = candidate
		case "port":
			value[4] = candidate
		case "priority":
			value[5] = candidate
		case "extra":
			value[6] = uint64(0)
		case "missingPriority":
			delete(value, 5)
		}
	}
	return value
}

type rawEndpointOptions struct {
	version              *uint64
	endpointEpoch        *uint64
	connectionGeneration *uint64
	candidates           []any
	extra                bool
}

func rawEndpointCBOR(options rawEndpointOptions) ([]byte, error) {
	version, epoch, generation := uint64(1), uint64(1), uint64(1)
	if options.version != nil {
		version = *options.version
	}
	if options.endpointEpoch != nil {
		epoch = *options.endpointEpoch
	}
	if options.connectionGeneration != nil {
		generation = *options.connectionGeneration
	}
	value := map[uint64]any{1: version, 2: epoch, 3: generation, 4: options.candidates}
	if options.extra {
		value[5] = uint64(0)
	}
	return pairing.EncodeCanonicalCBOR(value)
}

func endpointPlaintextRejections(valid []byte) ([]any, error) {
	value := func(number uint64) *uint64 { return &number }
	duplicate := rawEndpointCandidate(nil)
	thirteen := make([]any, 13)
	for index := range thirteen {
		thirteen[index] = rawEndpointCandidate(map[string]any{
			"address": []byte{10, 0, 0, byte(index + 1)}, "priority": uint64(100 - index),
		})
	}
	unsorted := []any{
		rawEndpointCandidate(map[string]any{"priority": uint64(10)}),
		rawEndpointCandidate(map[string]any{"address": []byte{192, 168, 1, 11}, "priority": uint64(20)}),
	}
	type rawCase struct {
		name string
		make func() ([]byte, error)
		code string
	}
	cases := []rawCase{
		{"wrong-version", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{version: value(2), candidates: []any{rawEndpointCandidate(nil)}})
		}, "invalid_endpoint_record"},
		{"zero-endpoint-epoch", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{endpointEpoch: value(0), candidates: []any{rawEndpointCandidate(nil)}})
		}, "invalid_endpoint_record"},
		{"zero-connection-generation", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{connectionGeneration: value(0), candidates: []any{rawEndpointCandidate(nil)}})
		}, "invalid_endpoint_record"},
		{"too-many-candidates", func() ([]byte, error) { return rawEndpointCBOR(rawEndpointOptions{candidates: thirteen}) }, "invalid_endpoint_record"},
		{"unsorted-candidates", func() ([]byte, error) { return rawEndpointCBOR(rawEndpointOptions{candidates: unsorted}) }, "candidates_unsorted"},
		{"duplicate-candidate", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{duplicate, duplicate}})
		}, "duplicate_candidate"},
		{"relay-kind", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"kind": uint64(4)})}})
		}, "invalid_endpoint_record"},
		{"wrong-family", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"family": uint64(5)})}})
		}, "invalid_endpoint_record"},
		{"wrong-address-width", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"address": bytes.Repeat([]byte{1}, 5)})}})
		}, "invalid_endpoint_record"},
		{"zero-port", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"port": uint64(0)})}})
		}, "invalid_endpoint_record"},
		{"port-overflow", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"port": uint64(65536)})}})
		}, "invalid_endpoint_record"},
		{"priority-overflow", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"priority": uint64(4294967296)})}})
		}, "invalid_endpoint_record"},
		{"ipv4-unspecified", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"address": make([]byte, 4)})}})
		}, "unsafe_candidate"},
		{"ipv4-loopback", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"address": []byte{127, 0, 0, 1}})}})
		}, "unsafe_candidate"},
		{"ipv4-link-local", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"address": []byte{169, 254, 1, 2}})}})
		}, "unsafe_candidate"},
		{"ipv4-multicast", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"address": []byte{224, 0, 0, 1}})}})
		}, "unsafe_candidate"},
		{"ipv4-broadcast", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"address": bytes.Repeat([]byte{255}, 4)})}})
		}, "unsafe_candidate"},
		{"ipv6-unspecified", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"family": uint64(6), "address": make([]byte, 16)})}})
		}, "unsafe_candidate"},
		{"ipv6-loopback", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"family": uint64(6), "address": append(make([]byte, 15), 1)})}})
		}, "unsafe_candidate"},
		{"ipv6-link-local", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"family": uint64(6), "address": endpointHex("fe800000000000000000000000000001")})}})
		}, "unsafe_candidate"},
		{"ipv6-multicast", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"family": uint64(6), "address": endpointHex("ff020000000000000000000000000001")})}})
		}, "unsafe_candidate"},
		{"ipv4-mapped-ipv6", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"family": uint64(6), "address": endpointHex("00000000000000000000ffffc0000201")})}})
		}, "unsafe_candidate"},
		{"extra-record-field", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(nil)}, extra: true})
		}, "invalid_endpoint_record"},
		{"missing-candidate-field", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"missingPriority": true})}})
		}, "invalid_endpoint_record"},
		{"extra-candidate-field", func() ([]byte, error) {
			return rawEndpointCBOR(rawEndpointOptions{candidates: []any{rawEndpointCandidate(map[string]any{"extra": true})}})
		}, "invalid_endpoint_record"},
	}
	result := make([]any, 0, len(cases)+3)
	for _, candidate := range cases {
		encoded, err := candidate.make()
		if err != nil {
			return nil, err
		}
		result = append(result, map[string]any{"name": candidate.name, "plaintextB64": pairing.B64(encoded), "errorCode": candidate.code})
	}
	noncanonical := append(append(append([]byte(nil), valid[:2]...), 0x18, 0x01), valid[3:]...)
	result = append(result,
		map[string]any{"name": "noncanonical-integer", "plaintextB64": pairing.B64(noncanonical), "errorCode": "invalid_canonical_cbor"},
		map[string]any{"name": "trailing-cbor", "plaintextB64": pairing.B64(append(append([]byte(nil), valid...), 0)), "errorCode": "invalid_canonical_cbor"},
		map[string]any{"name": "plaintext-over-limit", "plaintextB64": pairing.B64(make([]byte, pairing.EndpointPlaintextMax+1)), "errorCode": "plaintext_too_large"},
	)
	return result, nil
}

func endpointHex(value string) []byte {
	result, err := hex.DecodeString(value)
	if err != nil {
		return []byte{}
	}
	return result
}

func endpointRejection(name string, context pairing.EndpointContext, ciphertext []byte, approved bool, code string) map[string]any {
	return map[string]any{
		"name": name, "context": endpointContextMap(context), "ciphertextB64": pairing.B64(ciphertext),
		"approved": approved, "errorCode": code,
	}
}

func BuildEndpointEnvelopeV1Fixture() (map[string]any, error) {
	pairingFixture, err := BuildPairingV1Fixture()
	if err != nil {
		return nil, err
	}
	handshakes, ok := pairingFixture["handshakes"].([]any)
	if !ok || len(handshakes) == 0 {
		return nil, fmt.Errorf("pairing fixture handshakes missing")
	}
	handshake, err := fixtureObject(handshakes[0], "full-token handshake")
	if err != nil {
		return nil, err
	}
	pairContext, err := fixtureObject(handshake["pairContext"], "pair context")
	if err != nil {
		return nil, err
	}
	derived, err := fixtureObject(handshake["derived"], "pair keys")
	if err != nil {
		return nil, err
	}
	decodeField := func(value any, name string) ([]byte, error) {
		text, err := fixtureString(value, name)
		if err != nil {
			return nil, err
		}
		return pairing.DecodeB64(text)
	}
	hostKey, err := decodeField(derived["coordinationHostToRemoteKeyB64"], "host endpoint key")
	if err != nil {
		return nil, err
	}
	remoteKey, err := decodeField(derived["coordinationRemoteToHostKeyB64"], "remote endpoint key")
	if err != nil {
		return nil, err
	}
	pairID, err := decodeField(pairContext["pairIdB64"], "pair ID")
	if err != nil {
		return nil, err
	}
	hostHash, err := decodeField(pairContext["hostBundleHashB64"], "host bundle hash")
	if err != nil {
		return nil, err
	}
	remoteHash, err := decodeField(pairContext["remoteBundleHashB64"], "remote bundle hash")
	if err != nil {
		return nil, err
	}
	keys := pairing.EndpointDirectionKeys{HostToRemote: hostKey, RemoteToHost: remoteKey}
	hostContext := pairing.EndpointContext{
		PairID: pairID, SenderRole: 1, ReceiverRole: 2,
		HostInstallationBundleHash: hostHash, RemoteInstallationBundleHash: remoteHash,
		HostTrustEpoch: 1, RemoteTrustEpoch: 2, EndpointEpoch: 1,
	}
	remoteContext := endpointCloneContext(hostContext)
	remoteContext.SenderRole, remoteContext.ReceiverRole = 2, 1
	hostValue := pairing.EndpointGeneration{Version: 1, EndpointEpoch: 1, ConnectionGeneration: 1, Candidates: []pairing.EndpointCandidate{
		{Kind: 1, Family: 4, Address: []byte{192, 168, 1, 10}, Port: 41641, Priority: 400},
		{Kind: 1, Family: 6, Address: endpointHex("fd000000000000000000000000000001"), Port: 41641, Priority: 300},
		{Kind: 2, Family: 4, Address: []byte{203, 0, 113, 9}, Port: 51234, Priority: 200},
		{Kind: 3, Family: 4, Address: []byte{198, 51, 100, 5}, Port: 41641, Priority: 100},
	}}
	remoteValue := pairing.EndpointGeneration{Version: 1, EndpointEpoch: 1, ConnectionGeneration: 1, Candidates: []pairing.EndpointCandidate{
		{Kind: 1, Family: 6, Address: endpointHex("20010db8000000000000000000000009"), Port: 41641, Priority: 500},
		{Kind: 1, Family: 4, Address: []byte{10, 0, 0, 8}, Port: 41641, Priority: 400},
	}}
	maximumContext := endpointCloneContext(hostContext)
	maximumContext.EndpointEpoch = 2
	maximumCandidates := make([]pairing.EndpointCandidate, 12)
	for index := range maximumCandidates {
		maximumCandidates[index] = pairing.EndpointCandidate{
			Kind: 1, Family: 4, Address: []byte{10, 0, 1, byte(index + 1)},
			Port: uint16(41641 + index), Priority: uint32(1000 - index),
		}
	}
	maximumValue := pairing.EndpointGeneration{Version: 1, EndpointEpoch: 2, ConnectionGeneration: 1, Candidates: maximumCandidates}
	type vector struct {
		name    string
		context pairing.EndpointContext
		value   pairing.EndpointGeneration
	}
	vectors := []vector{
		{"host-to-remote", hostContext, hostValue},
		{"remote-to-host", remoteContext, remoteValue},
		{"maximum-candidates", maximumContext, maximumValue},
	}
	envelopes := make([]any, 0, len(vectors))
	maximumValidRecordBytes := 0
	for _, vector := range vectors {
		encrypted, err := pairing.EncryptEndpointEnvelope(keys, vector.context, vector.value, true)
		if err != nil {
			return nil, err
		}
		if len(encrypted.Plaintext) > maximumValidRecordBytes {
			maximumValidRecordBytes = len(encrypted.Plaintext)
		}
		envelopes = append(envelopes, map[string]any{
			"name": vector.name, "context": endpointContextMap(vector.context), "value": endpointValueMap(vector.value),
			"plaintextB64": pairing.B64(encrypted.Plaintext), "nonceB64": pairing.B64(encrypted.Nonce),
			"associatedDataB64": pairing.B64(encrypted.AssociatedData), "ciphertextB64": pairing.B64(encrypted.Ciphertext),
			"ciphertextSha256B64": pairing.B64(pairing.Hash(encrypted.Ciphertext)),
		})
	}
	hostEncrypted, err := pairing.EncryptEndpointEnvelope(keys, hostContext, hostValue, true)
	if err != nil {
		return nil, err
	}
	tampered := append([]byte(nil), hostEncrypted.Ciphertext...)
	tampered[0] ^= 1
	wrongDirection := endpointCloneContext(hostContext)
	wrongDirection.SenderRole, wrongDirection.ReceiverRole = 2, 1
	wrongPair := endpointCloneContext(hostContext)
	wrongPair.PairID = endpointMutate(wrongPair.PairID)
	wrongHostHash := endpointCloneContext(hostContext)
	wrongHostHash.HostInstallationBundleHash = endpointMutate(wrongHostHash.HostInstallationBundleHash)
	wrongRemoteHash := endpointCloneContext(hostContext)
	wrongRemoteHash.RemoteInstallationBundleHash = endpointMutate(wrongRemoteHash.RemoteInstallationBundleHash)
	wrongHostEpoch := endpointCloneContext(hostContext)
	wrongHostEpoch.HostTrustEpoch = 2
	wrongRemoteEpoch := endpointCloneContext(hostContext)
	wrongRemoteEpoch.RemoteTrustEpoch = 3
	wrongMinor := endpointCloneContext(hostContext)
	wrongMinor.NegotiatedMinor = 1
	wrongEndpointEpoch := endpointCloneContext(hostContext)
	wrongEndpointEpoch.EndpointEpoch = 2
	sameRole := endpointCloneContext(hostContext)
	sameRole.ReceiverRole = 1
	envelopeRejections := []any{
		endpointRejection("tampered-ciphertext", hostContext, tampered, true, "aead_authentication_failed"),
		endpointRejection("wrong-direction", wrongDirection, hostEncrypted.Ciphertext, true, "aead_authentication_failed"),
		endpointRejection("wrong-pair", wrongPair, hostEncrypted.Ciphertext, true, "aead_authentication_failed"),
		endpointRejection("wrong-host-bundle", wrongHostHash, hostEncrypted.Ciphertext, true, "aead_authentication_failed"),
		endpointRejection("wrong-remote-bundle", wrongRemoteHash, hostEncrypted.Ciphertext, true, "aead_authentication_failed"),
		endpointRejection("wrong-host-epoch", wrongHostEpoch, hostEncrypted.Ciphertext, true, "aead_authentication_failed"),
		endpointRejection("wrong-remote-epoch", wrongRemoteEpoch, hostEncrypted.Ciphertext, true, "aead_authentication_failed"),
		endpointRejection("wrong-protocol-minor", wrongMinor, hostEncrypted.Ciphertext, true, "aead_authentication_failed"),
		endpointRejection("wrong-endpoint-epoch", wrongEndpointEpoch, hostEncrypted.Ciphertext, true, "aead_authentication_failed"),
		endpointRejection("same-role-context", sameRole, hostEncrypted.Ciphertext, true, "invalid_context"),
		endpointRejection("unapproved-sender", hostContext, hostEncrypted.Ciphertext, false, "unapproved_sender"),
		endpointRejection("ciphertext-over-limit", hostContext, make([]byte, 1201), true, "ciphertext_too_large"),
		endpointRejection("ciphertext-shorter-than-tag", hostContext, make([]byte, 15), true, "aead_authentication_failed"),
	}
	mismatchPlaintext, err := rawEndpointCBOR(rawEndpointOptions{endpointEpoch: func() *uint64 { value := uint64(2); return &value }(), candidates: []any{rawEndpointCandidate(nil)}})
	if err != nil {
		return nil, err
	}
	mismatchCiphertext, err := pairing.EncryptEndpointAEAD(hostKey, hostEncrypted.Nonce, hostEncrypted.AssociatedData, mismatchPlaintext)
	if err != nil {
		return nil, err
	}
	envelopeRejections = append(envelopeRejections, endpointRejection(
		"authenticated-plaintext-epoch-mismatch", hostContext, mismatchCiphertext, true, "epoch_mismatch",
	))
	advancedContext := endpointCloneContext(hostContext)
	advancedContext.EndpointEpoch = 3
	advancedValue := pairing.EndpointGeneration{Version: 1, EndpointEpoch: 3, ConnectionGeneration: 2, Candidates: []pairing.EndpointCandidate{
		{Kind: 2, Family: 4, Address: []byte{203, 0, 113, 10}, Port: 52000, Priority: 600},
	}}
	advancedEncrypted, err := pairing.EncryptEndpointEnvelope(keys, advancedContext, advancedValue, true)
	if err != nil {
		return nil, err
	}
	boundaryPlaintext := make([]byte, pairing.EndpointPlaintextMax)
	for index := range boundaryPlaintext {
		boundaryPlaintext[index] = byte(index)
	}
	boundaryNonce, err := pairing.EndpointNonce(hostContext.EndpointEpoch)
	if err != nil {
		return nil, err
	}
	boundaryAD, err := pairing.EncodeEndpointAssociatedData(hostContext)
	if err != nil {
		return nil, err
	}
	boundaryCiphertext, err := pairing.EncryptEndpointAEAD(hostKey, boundaryNonce, boundaryAD, boundaryPlaintext)
	if err != nil {
		return nil, err
	}
	plaintextRejections, err := endpointPlaintextRejections(hostEncrypted.Plaintext)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"version":   1,
		"roles":     map[string]any{"host": 1, "remote": 2},
		"limits":    map[string]any{"candidates": 12, "plaintextBytes": 1184, "ciphertextBytes": 1200},
		"keys":      map[string]any{"hostToRemoteKeyB64": pairing.B64(hostKey), "remoteToHostKeyB64": pairing.B64(remoteKey)},
		"envelopes": envelopes,
		"epochAdvance": map[string]any{
			"context": endpointContextMap(advancedContext), "value": endpointValueMap(advancedValue),
			"ciphertextB64": pairing.B64(advancedEncrypted.Ciphertext),
		},
		"boundary": map[string]any{
			"keyB64": pairing.B64(hostKey), "nonceB64": pairing.B64(boundaryNonce),
			"associatedDataB64": pairing.B64(boundaryAD), "plaintextB64": pairing.B64(boundaryPlaintext),
			"ciphertextB64": pairing.B64(boundaryCiphertext), "overLimitPlaintextB64": pairing.B64(make([]byte, pairing.EndpointPlaintextMax+1)),
			"maximumValidRecordBytes": maximumValidRecordBytes,
		},
		"rejections": map[string]any{"plaintext": plaintextRejections, "envelopes": envelopeRejections},
	}, nil
}

func BuildEndpointEnvelopeV1JSON() ([]byte, error) {
	fixture, err := BuildEndpointEnvelopeV1Fixture()
	if err != nil {
		return nil, err
	}
	return canonicalJSON(fixture)
}
