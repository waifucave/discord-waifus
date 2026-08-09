package vectors

import (
	"bytes"
	"crypto/ed25519"
	"encoding/binary"
	"encoding/json"
	"fmt"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
)

const (
	serviceAcceptedAt     uint64 = 1786270830
	serviceGatewayExpires        = serviceAcceptedAt + 600
)

func serviceSessionInput() pairing.ApplicationSessionContext {
	return pairing.ApplicationSessionContext{
		NegotiatedMinor:              0,
		PairID:                       pairing.Sequence(0x60, 16),
		ServiceID:                    pairing.Sequence(0x70, 16),
		HostNonce:                    pairing.Sequence(0x80, 32),
		RemoteNonce:                  pairing.Sequence(0xa0, 32),
		HostInstallationBundleHash:   pairing.Sequence(0xc0, 32),
		RemoteInstallationBundleHash: pairing.Sequence(0xe0, 32),
		HostTrustEpoch:               9007199254740992,
		RemoteTrustEpoch:             18446744073709551615,
		HostTransportSessionID:       bytes.Repeat([]byte{0x11}, 16),
		RemoteTransportSessionID:     bytes.Repeat([]byte{0x22}, 16),
	}
}

func serviceCloneBytes(value []byte) []byte {
	return append([]byte(nil), value...)
}

func serviceCloneSession(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
	value.PairID = serviceCloneBytes(value.PairID)
	value.ServiceID = serviceCloneBytes(value.ServiceID)
	value.HostNonce = serviceCloneBytes(value.HostNonce)
	value.RemoteNonce = serviceCloneBytes(value.RemoteNonce)
	value.HostInstallationBundleHash = serviceCloneBytes(value.HostInstallationBundleHash)
	value.RemoteInstallationBundleHash = serviceCloneBytes(value.RemoteInstallationBundleHash)
	value.HostTransportSessionID = serviceCloneBytes(value.HostTransportSessionID)
	value.RemoteTransportSessionID = serviceCloneBytes(value.RemoteTransportSessionID)
	return value
}

func serviceMutate(value []byte) []byte {
	result := serviceCloneBytes(value)
	result[0] ^= 1
	return result
}

func serviceSessionInputMap(value pairing.ApplicationSessionContext) map[string]any {
	return map[string]any{
		"negotiatedMinor":                 int(value.NegotiatedMinor),
		"pairIdB64":                       pairing.B64(value.PairID),
		"serviceIdB64":                    pairing.B64(value.ServiceID),
		"hostNonceB64":                    pairing.B64(value.HostNonce),
		"remoteNonceB64":                  pairing.B64(value.RemoteNonce),
		"hostInstallationBundleHashB64":   pairing.B64(value.HostInstallationBundleHash),
		"remoteInstallationBundleHashB64": pairing.B64(value.RemoteInstallationBundleHash),
		"hostTrustEpoch":                  fmt.Sprintf("%d", value.HostTrustEpoch),
		"remoteTrustEpoch":                fmt.Sprintf("%d", value.RemoteTrustEpoch),
		"hostTransportSessionIdB64":       pairing.B64(value.HostTransportSessionID),
		"remoteTransportSessionIdB64":     pairing.B64(value.RemoteTransportSessionID),
	}
}

func serviceApplicationSessionRejections(base pairing.ApplicationSessionContext) []any {
	variants := []struct {
		name  string
		build func(pairing.ApplicationSessionContext) pairing.ApplicationSessionContext
	}{
		{"wrong-protocol-minor", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.NegotiatedMinor++
			return value
		}},
		{"wrong-pair-id", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.PairID = serviceMutate(value.PairID)
			return value
		}},
		{"wrong-service-id", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.ServiceID = serviceMutate(value.ServiceID)
			return value
		}},
		{"swapped-nonces", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.HostNonce, value.RemoteNonce = value.RemoteNonce, value.HostNonce
			return value
		}},
		{"swapped-bundle-hashes", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.HostInstallationBundleHash, value.RemoteInstallationBundleHash = value.RemoteInstallationBundleHash, value.HostInstallationBundleHash
			return value
		}},
		{"swapped-trust-epochs", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.HostTrustEpoch, value.RemoteTrustEpoch = value.RemoteTrustEpoch, value.HostTrustEpoch
			return value
		}},
		{"swapped-transport-session-ids", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.HostTransportSessionID, value.RemoteTransportSessionID = value.RemoteTransportSessionID, value.HostTransportSessionID
			return value
		}},
		{"wrong-host-nonce", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.HostNonce = serviceMutate(value.HostNonce)
			return value
		}},
		{"wrong-remote-nonce", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.RemoteNonce = serviceMutate(value.RemoteNonce)
			return value
		}},
		{"wrong-host-bundle-hash", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.HostInstallationBundleHash = serviceMutate(value.HostInstallationBundleHash)
			return value
		}},
		{"wrong-remote-bundle-hash", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.RemoteInstallationBundleHash = serviceMutate(value.RemoteInstallationBundleHash)
			return value
		}},
		{"wrong-host-trust-epoch", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.HostTrustEpoch++
			return value
		}},
		{"wrong-remote-trust-epoch", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.RemoteTrustEpoch--
			return value
		}},
		{"wrong-host-transport-session-id", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.HostTransportSessionID = serviceMutate(value.HostTransportSessionID)
			return value
		}},
		{"wrong-remote-transport-session-id", func(value pairing.ApplicationSessionContext) pairing.ApplicationSessionContext {
			value.RemoteTransportSessionID = serviceMutate(value.RemoteTransportSessionID)
			return value
		}},
	}
	result := make([]any, 0, len(variants))
	for _, variant := range variants {
		value := variant.build(serviceCloneSession(base))
		result = append(result, map[string]any{"name": variant.name, "inputs": serviceSessionInputMap(value)})
	}
	return result
}

func serviceEncodingRejections(signed []byte) []any {
	wrongDomain := serviceCloneBytes(signed)
	wrongDomain[4] ^= 1
	wrongProtocolMajor := serviceCloneBytes(signed)
	wrongProtocolMajor[30] ^= 1
	nonNegotiatedMinor := serviceCloneBytes(signed)
	nonNegotiatedMinor[32] ^= 1
	wrongPairWidth := serviceCloneBytes(signed)
	binary.BigEndian.PutUint32(wrongPairWidth[33:37], 15)
	wrongDomainWidth := serviceCloneBytes(signed)
	binary.BigEndian.PutUint32(wrongDomainWidth[:4], 20)
	values := []struct {
		name    string
		payload []byte
	}{
		{"truncated", signed[:len(signed)-1]},
		{"trailing-byte", append(serviceCloneBytes(signed), 0)},
		{"wrong-domain", wrongDomain},
		{"wrong-protocol-major", wrongProtocolMajor},
		{"non-negotiated-minor", nonNegotiatedMinor},
		{"wrong-pair-width", wrongPairWidth},
		{"wrong-domain-width", wrongDomainWidth},
	}
	result := make([]any, 0, len(values))
	for _, value := range values {
		result = append(result, map[string]any{
			"name": value.name, "payloadB64": pairing.B64(value.payload), "expectedMinor": 0,
		})
	}
	return result
}

func serviceAuthTrace(role string, events []string) ([]any, error) {
	state, err := pairing.NewApplicationSessionAuthentication(role)
	if err != nil {
		return nil, err
	}
	result := make([]any, 0, len(events))
	for _, event := range events {
		if err := state.Transition(event); err != nil {
			return nil, err
		}
		result = append(result, map[string]any{
			"event": event, "state": state.State, "requestStartAllowed": state.CanAcceptRequestStart(),
		})
	}
	return result, nil
}

func serviceEnvelopeMap(value pairing.RemoteBrowserContextEnvelope) (map[string]any, error) {
	encoded, err := pairing.CanonicalJSONV1(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var result map[string]any
	if err := decoder.Decode(&result); err != nil {
		return nil, err
	}
	return result, nil
}

func serviceCloneMap(value map[string]any) (map[string]any, error) {
	encoded, err := pairing.CanonicalJSONV1(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var result map[string]any
	if err := decoder.Decode(&result); err != nil {
		return nil, err
	}
	return result, nil
}

func serviceBrowserRejections(value pairing.RemoteBrowserContextEnvelope) ([]any, error) {
	base, err := serviceEnvelopeMap(value)
	if err != nil {
		return nil, err
	}
	variants := []struct {
		name  string
		apply func(map[string]any)
	}{
		{"gateway-launch-substitution", func(candidate map[string]any) {
			candidate["browserContext"].(map[string]any)["gatewayLaunchId"] = pairing.B64(bytes.Repeat([]byte{0x99}, 32))
		}},
		{"browser-session-substitution", func(candidate map[string]any) {
			candidate["browserContext"].(map[string]any)["browserSessionId"] = pairing.B64(bytes.Repeat([]byte{0x9a}, 32))
		}},
		{"request-nonce-substitution", func(candidate map[string]any) {
			candidate["browserContext"].(map[string]any)["requestNonce"] = pairing.B64(bytes.Repeat([]byte{0x9b}, 16))
		}},
		{"method-substitution", func(candidate map[string]any) { candidate["browserContext"].(map[string]any)["method"] = "GET" }},
		{"target-substitution", func(candidate map[string]any) {
			candidate["browserContext"].(map[string]any)["canonicalTarget"] = "/api/remote-access"
		}},
		{"query-order-substitution", func(candidate map[string]any) {
			candidate["browserContext"].(map[string]any)["canonicalTarget"] = "/api/waifus?id=two&id=one&name=hello%20world"
		}},
		{"percent-encoding-substitution", func(candidate map[string]any) {
			candidate["browserContext"].(map[string]any)["canonicalTarget"] = "/api/waifus?id=one&id=two&name=hello%2520world"
		}},
		{"pair-substitution", func(candidate map[string]any) { candidate["pairId"] = pairing.B64(bytes.Repeat([]byte{0x9c}, 16)) }},
		{"device-substitution", func(candidate map[string]any) { candidate["remoteDeviceId"] = "remote-device-02" }},
		{"bundle-substitution", func(candidate map[string]any) {
			candidate["remoteInstallationBundleHash"] = pairing.B64(bytes.Repeat([]byte{0x9d}, 32))
		}},
		{"host-epoch-substitution", func(candidate map[string]any) { candidate["hostTrustEpoch"] = "9007199254740993" }},
		{"remote-epoch-substitution", func(candidate map[string]any) { candidate["remoteTrustEpoch"] = "18446744073709551614" }},
		{"application-session-substitution", func(candidate map[string]any) {
			candidate["applicationSessionHash"] = pairing.B64(bytes.Repeat([]byte{0x9e}, 32))
		}},
		{"direct-request-substitution", func(candidate map[string]any) {
			candidate["directRequestId"] = pairing.B64(bytes.Repeat([]byte{0x9f}, 16))
		}},
		{"parent-stream-substitution", func(candidate map[string]any) { candidate["remoteParentStreamId"] = "9007199254740995" }},
		{"mac-substitution", func(candidate map[string]any) { candidate["mac"] = pairing.B64(bytes.Repeat([]byte{0xa1}, 32)) }},
	}
	result := make([]any, 0, len(variants))
	for _, variant := range variants {
		candidate, err := serviceCloneMap(base)
		if err != nil {
			return nil, err
		}
		variant.apply(candidate)
		result = append(result, map[string]any{"name": variant.name, "envelope": candidate})
	}
	return result, nil
}

func serviceBrowserStructuralRejections(value pairing.RemoteBrowserContextEnvelope) ([]any, error) {
	base, err := serviceEnvelopeMap(value)
	if err != nil {
		return nil, err
	}
	variants := []struct {
		name  string
		apply func(map[string]any)
	}{
		{"csrf-not-validated", func(candidate map[string]any) { candidate["browserContext"].(map[string]any)["csrfValidated"] = false }},
		{"noncanonical-target", func(candidate map[string]any) {
			candidate["browserContext"].(map[string]any)["canonicalTarget"] = "/api/%41"
		}},
		{"lowercase-percent-escape", func(candidate map[string]any) {
			candidate["browserContext"].(map[string]any)["canonicalTarget"] = "/api/waifus?next=%2fadmin"
		}},
		{"even-parent-stream", func(candidate map[string]any) { candidate["remoteParentStreamId"] = "2" }},
		{"wrong-direct-stream", func(candidate map[string]any) { candidate["directStreamId"] = "3" }},
		{"extra-header-field", func(candidate map[string]any) {
			candidate["forwardedHeaders"] = map[string]any{"x-waifus-browser-context": "forged"}
		}},
	}
	result := make([]any, 0, len(variants))
	for _, variant := range variants {
		candidate, err := serviceCloneMap(base)
		if err != nil {
			return nil, err
		}
		variant.apply(candidate)
		result = append(result, map[string]any{"name": variant.name, "envelope": candidate})
	}
	return result, nil
}

func serviceApprovalReceipt(kind string) map[string]any {
	repeatB64 := func(length int, value byte) string { return pairing.B64(bytes.Repeat([]byte{value}, length)) }
	receipt := map[string]any{
		"version": 1, "receiptId": repeatB64(32, 0x61),
		"issuedAt": "1786270830", "expiresAt": "1786270950",
		"invitationId": repeatB64(16, 0x62), "invitationGeneration": "1",
		"pendingPairId":            repeatB64(16, 0x63),
		"hostIdentityBundleCbor":   pairing.B64([]byte{0xa1, 0x01, 0x01}),
		"hostIdentityBundleHash":   repeatB64(32, 0x64),
		"remoteIdentityBundleCbor": pairing.B64([]byte{0xa1, 0x01, 0x02}),
		"remoteIdentityBundleHash": repeatB64(32, 0x65),
		"noisePattern":             "Noise_XXpsk0_25519_ChaChaPoly_SHA256",
		"protocol":                 map[string]any{"major": 1, "minor": 0},
		"transcriptHash":           repeatB64(32, 0x66), "channelBinding": repeatB64(32, 0x67),
		"sasIndices": []any{1, 23, 456, 789, 1023}, "sasFingerprint": "a1b2c3d4e5f6",
		"hostTrustEpoch": "1", "remoteTrustEpoch": "2",
		"hostKeySequence": 1, "remoteKeySequence": 1,
		"confirmationRequestNonce": repeatB64(16, 0x6d), "confirmationMethod": "POST",
		"confirmationTarget": "/api/remote-access/pairing-requests/request-1/approve",
		"nonce":              repeatB64(32, 0x6e), "action": "approve_pair",
	}
	if kind == "local" {
		receipt["approvingPrincipal"] = map[string]any{"kind": "local", "stableId": "local"}
		receipt["browserBinding"] = map[string]any{
			"kind": "local", "hostServerLaunchId": repeatB64(32, 0x69), "browserSessionId": repeatB64(32, 0x6a),
		}
	} else {
		receipt["approvingPrincipal"] = map[string]any{
			"kind": "remote_device", "stableId": "remote:approver-device",
			"peerFingerprint": repeatB64(16, 0x68), "trustEpoch": "7",
		}
		receipt["browserBinding"] = map[string]any{
			"kind": "remote", "gatewayLaunchId": repeatB64(32, 0x6b), "browserSessionId": repeatB64(32, 0x6c),
		}
	}
	return receipt
}

func serviceApprovalVectors() ([]any, error) {
	result := make([]any, 0, 2)
	for _, kind := range []string{"local", "remote"} {
		value := serviceApprovalReceipt(kind)
		canonical, contextHash, err := pairing.ApprovalContextHash(value)
		if err != nil {
			return nil, err
		}
		result = append(result, map[string]any{
			"kind": kind, "value": value,
			"canonicalBytesB64": pairing.B64(canonical), "contextHashB64": pairing.B64(contextHash),
		})
	}
	return result, nil
}

func BuildServiceSessionV1Fixture() (map[string]any, error) {
	hostSeed := pairing.Sequence(0x00, 32)
	remoteSeed := pairing.Sequence(0x20, 32)
	pairRoot := pairing.Sequence(0x40, 32)
	session := serviceSessionInput()
	proofs, err := pairing.CreateApplicationSessionProofs(session, hostSeed, remoteSeed)
	if err != nil {
		return nil, err
	}
	hostPublic := ed25519.NewKeyFromSeed(hostSeed).Public().(ed25519.PublicKey)
	remotePublic := ed25519.NewKeyFromSeed(remoteSeed).Public().(ed25519.PublicKey)
	browserKey, err := pairing.DeriveRemoteBrowserContextKey(pairRoot, proofs.ApplicationSessionHash, session)
	if err != nil {
		return nil, err
	}
	envelope, err := pairing.SignRemoteBrowserContextEnvelope(browserKey, pairing.RemoteBrowserContextEnvelope{
		Version: 1,
		BrowserContext: pairing.RemoteBrowserContext{
			Version:          1,
			GatewayLaunchID:  pairing.B64(bytes.Repeat([]byte{0x55}, 32)),
			BrowserSessionID: pairing.B64(bytes.Repeat([]byte{0x66}, 32)),
			RequestNonce:     pairing.B64(bytes.Repeat([]byte{0x77}, 16)),
			Method:           "POST", CanonicalTarget: "/api/waifus?id=one&id=two&name=hello%20world", CSRFValidated: true,
		},
		PairID: pairing.B64(session.PairID), RemoteDeviceID: "remote-device-01",
		RemoteInstallationBundleHash: pairing.B64(session.RemoteInstallationBundleHash),
		HostTrustEpoch:               fmt.Sprintf("%d", session.HostTrustEpoch), RemoteTrustEpoch: fmt.Sprintf("%d", session.RemoteTrustEpoch),
		ApplicationSessionHash: pairing.B64(proofs.ApplicationSessionHash),
		DirectRequestID:        pairing.B64(bytes.Repeat([]byte{0x88}, 16)),
		RemoteParentStreamID:   "9007199254740993", DirectStreamID: "1",
	})
	if err != nil {
		return nil, err
	}
	canonicalContext, err := pairing.CanonicalRemoteBrowserContextJSON(envelope.BrowserContext)
	if err != nil {
		return nil, err
	}
	macInput, err := pairing.RemoteBrowserContextMACInput(envelope)
	if err != nil {
		return nil, err
	}
	remoteTrace, err := serviceAuthTrace("remote", []string{"send_hello", "receive_verified_hello_ack", "send_authenticate_peer", "receive_success_result"})
	if err != nil {
		return nil, err
	}
	hostTrace, err := serviceAuthTrace("host", []string{"receive_hello", "send_hello_ack", "receive_verified_authenticate_peer", "send_success_result"})
	if err != nil {
		return nil, err
	}
	browserRejections, err := serviceBrowserRejections(envelope)
	if err != nil {
		return nil, err
	}
	structuralRejections, err := serviceBrowserStructuralRejections(envelope)
	if err != nil {
		return nil, err
	}
	approvalVectors, err := serviceApprovalVectors()
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"version": 1,
		"roles":   map[string]any{"host": 1, "remote": 2},
		"applicationSession": map[string]any{
			"inputs":                  serviceSessionInputMap(session),
			"hostInstallationSeedB64": pairing.B64(hostSeed), "remoteInstallationSeedB64": pairing.B64(remoteSeed),
			"hostInstallationPublicKeyB64": pairing.B64(hostPublic), "remoteInstallationPublicKeyB64": pairing.B64(remotePublic),
			"signedBytesB64": pairing.B64(proofs.SignedBytes), "digestB64": pairing.B64(proofs.Digest),
			"hostSignatureB64": pairing.B64(proofs.HostSignature), "remoteSignatureB64": pairing.B64(proofs.RemoteSignature),
			"applicationSessionHashB64": pairing.B64(proofs.ApplicationSessionHash),
			"authSequence":              map[string]any{"remote": remoteTrace, "host": hostTrace},
		},
		"remoteBrowserContext": map[string]any{
			"pairRootB64": pairing.B64(pairRoot), "acceptedAt": fmt.Sprintf("%d", serviceAcceptedAt),
			"gatewayExpiresAt":         fmt.Sprintf("%d", serviceGatewayExpires),
			"canonicalContextBytesB64": pairing.B64(canonicalContext), "browserContextKeyB64": pairing.B64(browserKey),
			"macInputB64": pairing.B64(macInput), "envelope": envelope,
		},
		"approvalReceipts": approvalVectors,
		"rejections": map[string]any{
			"applicationSession":             serviceApplicationSessionRejections(session),
			"applicationSessionEncoding":     serviceEncodingRejections(proofs.SignedBytes),
			"remoteBrowserContext":           browserRejections,
			"remoteBrowserContextStructural": structuralRejections,
			"applicationSessionAuthSequence": []any{
				map[string]any{"role": "host", "state": "idle", "forbiddenEvent": "receive_verified_authenticate_peer"},
				map[string]any{"role": "remote", "state": "idle", "forbiddenEvent": "receive_verified_hello_ack"},
				map[string]any{"role": "host", "state": "authenticated", "forbiddenEvent": "receive_hello"},
				map[string]any{"role": "remote", "state": "authenticated", "forbiddenEvent": "send_hello"},
			},
		},
	}, nil
}

func BuildServiceSessionV1JSON() ([]byte, error) {
	fixture, err := BuildServiceSessionV1Fixture()
	if err != nil {
		return nil, err
	}
	return canonicalJSON(fixture)
}
