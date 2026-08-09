package vectors

import (
	"bytes"
	"fmt"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
)

const (
	pairingAcceptedAt uint64 = 1786270800
	pairingExpiry     uint64 = pairingAcceptedAt + 300
)

func pairingMap(encoded []byte) (map[uint64]any, error) {
	decoded, err := pairing.DecodeCanonicalCBOR(encoded)
	if err != nil {
		return nil, err
	}
	value, ok := decoded.(map[uint64]any)
	if !ok {
		return nil, fmt.Errorf("expected pairing fixture CBOR map")
	}
	cloned := make(map[uint64]any, len(value))
	for key, field := range value {
		cloned[key] = field
	}
	return cloned, nil
}

func mutatePairingLast(value []byte) []byte {
	mutated := append([]byte(nil), value...)
	mutated[len(mutated)-1] ^= 1
	return mutated
}

func tokenFromCBOR(value []byte) string {
	return pairing.FullTokenPrefix + pairing.B64(value)
}

func identityJSON(identity *pairing.Identity) map[string]any {
	return map[string]any{
		"version":               1,
		"deviceId":              identity.DeviceID,
		"role":                  identity.Role,
		"trustEpoch":            fmt.Sprintf("%d", identity.TrustEpoch),
		"installationPublicKey": pairing.B64(identity.InstallationPublicKey),
		"nodePublicKey":         pairing.B64(identity.NodePublicKey),
		"discoveryPublicKey":    pairing.B64(identity.DiscoveryPublicKey),
		"keySequence":           1,
		"protocol": map[string]any{
			"major": identity.Protocol.Major,
			"minor": identity.Protocol.Minor,
		},
		"capabilities": map[string]any{
			"required": identity.RequiredCapabilities,
			"optional": identity.OptionalCapabilities,
		},
		"signature": pairing.B64(identity.Signature),
	}
}

func pairingPayloads(host, remote *pairing.Identity) ([][]byte, error) {
	first, err := pairing.EncodeCanonicalCBOR(map[uint64]any{
		1: uint64(1), 2: uint64(2), 3: remote.BundleHash,
	})
	if err != nil {
		return nil, err
	}
	second, err := pairing.EncodeCanonicalCBOR(map[uint64]any{
		1: uint64(1), 2: uint64(1), 3: host.BundleCBOR, 4: remote.BundleHash,
	})
	if err != nil {
		return nil, err
	}
	third, err := pairing.EncodeCanonicalCBOR(map[uint64]any{
		1: uint64(1), 2: uint64(2), 3: remote.BundleCBOR, 4: host.BundleHash,
	})
	if err != nil {
		return nil, err
	}
	return [][]byte{first, second, third}, nil
}

func b64Values(values [][]byte) []string {
	result := make([]string, len(values))
	for index, value := range values {
		result[index] = pairing.B64(value)
	}
	return result
}

type pairingHandshakeInput struct {
	name                   string
	invitationID           []byte
	generation             uint64
	pairID                 []byte
	hostStaticPrivate      []byte
	remoteStaticPrivate    []byte
	hostEphemeralPrivate   []byte
	remoteEphemeralPrivate []byte
	psk                    []byte
	hostContribution       []byte
	remoteContribution     []byte
	host                   *pairing.Identity
	remote                 *pairing.Identity
}

func pairingHandshake(value pairingHandshakeInput) (map[string]any, error) {
	prologue, err := pairing.NoisePrologue(value.invitationID, value.generation, value.pairID)
	if err != nil {
		return nil, err
	}
	payloads, err := pairingPayloads(value.host, value.remote)
	if err != nil {
		return nil, err
	}
	noiseResult, err := pairing.RunNoiseXX(
		prologue,
		value.psk,
		value.remoteStaticPrivate,
		value.hostStaticPrivate,
		value.remoteEphemeralPrivate,
		value.hostEphemeralPrivate,
		payloads,
		value.remoteContribution,
		value.hostContribution,
	)
	if err != nil {
		return nil, err
	}
	keys, err := pairing.DerivePairKeys(
		value.hostContribution,
		value.remoteContribution,
		noiseResult.ChannelBinding,
		value.invitationID,
		value.generation,
		value.pairID,
		value.host.BundleHash,
		value.remote.BundleHash,
		value.host.InstallationPublicKey,
		value.remote.InstallationPublicKey,
	)
	if err != nil {
		return nil, err
	}
	sas, err := pairing.DeriveSAS(
		noiseResult.ChannelBinding,
		value.pairID,
		value.host.BundleCBOR,
		value.remote.BundleCBOR,
	)
	if err != nil {
		return nil, err
	}
	remoteStaticPublic, _ := pairing.X25519Public(value.remoteStaticPrivate)
	hostStaticPublic, _ := pairing.X25519Public(value.hostStaticPrivate)
	remoteEphemeralPublic, _ := pairing.X25519Public(value.remoteEphemeralPrivate)
	hostEphemeralPublic, _ := pairing.X25519Public(value.hostEphemeralPrivate)
	var psk any
	if value.psk == nil {
		psk = nil
	} else {
		psk = pairing.B64(value.psk)
	}
	return map[string]any{
		"name":              value.name,
		"pattern":           noiseResult.Pattern,
		"messagesB64":       b64Values(noiseResult.Messages),
		"channelBindingB64": pairing.B64(noiseResult.ChannelBinding),
		"transcriptHashB64": pairing.B64(noiseResult.TranscriptHash),
		"inputs": map[string]any{
			"prologueB64":                     pairing.B64(prologue),
			"pskB64":                          psk,
			"initiatorStaticPrivateKeyB64":    pairing.B64(value.remoteStaticPrivate),
			"responderStaticPrivateKeyB64":    pairing.B64(value.hostStaticPrivate),
			"initiatorEphemeralPrivateKeyB64": pairing.B64(value.remoteEphemeralPrivate),
			"responderEphemeralPrivateKeyB64": pairing.B64(value.hostEphemeralPrivate),
			"initiatorStaticPublicKeyB64":     pairing.B64(remoteStaticPublic),
			"responderStaticPublicKeyB64":     pairing.B64(hostStaticPublic),
			"initiatorEphemeralPublicKeyB64":  pairing.B64(remoteEphemeralPublic),
			"responderEphemeralPublicKeyB64":  pairing.B64(hostEphemeralPublic),
			"payloadsB64":                     b64Values(payloads),
		},
		"transport": map[string]any{
			"initiatorToResponderKeyB64":      pairing.B64(noiseResult.InitiatorToResponderTransportKey),
			"responderToInitiatorKeyB64":      pairing.B64(noiseResult.ResponderToInitiatorTransportKey),
			"remoteContributionCiphertextB64": pairing.B64(noiseResult.RemoteContributionCiphertext),
			"hostContributionCiphertextB64":   pairing.B64(noiseResult.HostContributionCiphertext),
		},
		"pairContext": map[string]any{
			"invitationIdB64":                pairing.B64(value.invitationID),
			"invitationGeneration":           fmt.Sprintf("%d", value.generation),
			"pairIdB64":                      pairing.B64(value.pairID),
			"hostContributionB64":            pairing.B64(value.hostContribution),
			"remoteContributionB64":          pairing.B64(value.remoteContribution),
			"hostBundleCborB64":              pairing.B64(value.host.BundleCBOR),
			"remoteBundleCborB64":            pairing.B64(value.remote.BundleCBOR),
			"hostBundleHashB64":              pairing.B64(value.host.BundleHash),
			"remoteBundleHashB64":            pairing.B64(value.remote.BundleHash),
			"hostInstallationPublicKeyB64":   pairing.B64(value.host.InstallationPublicKey),
			"remoteInstallationPublicKeyB64": pairing.B64(value.remote.InstallationPublicKey),
		},
		"derived": map[string]any{
			"pairRootB64":                    pairing.B64(keys.PairRoot),
			"pairKeySaltB64":                 pairing.B64(keys.PairKeySalt),
			"coordinationHostToRemoteKeyB64": pairing.B64(keys.CoordinationHostToRemoteKey),
			"coordinationRemoteToHostKeyB64": pairing.B64(keys.CoordinationRemoteToHostKey),
			"confirmationKeyB64":             pairing.B64(keys.ConfirmationKey),
			"revocationKeyB64":               pairing.B64(keys.RevocationKey),
			"canonicalIdentityBundleHashB64": pairing.B64(sas.CanonicalIdentityBundleHash),
			"sasBytesB64":                    pairing.B64(sas.Bytes),
			"sasIndices":                     sas.Indices,
			"sasFingerprint":                 sas.Fingerprint,
		},
	}, nil
}

func BuildPairingV1Fixture() (map[string]any, error) {
	hostInstallationSeed := pairing.Sequence(0x00, 32)
	remoteInstallationSeed := pairing.Sequence(0x20, 32)
	host, err := pairing.CreateIdentity(
		1,
		hostInstallationSeed,
		pairing.Sequence(0x40, 32),
		pairing.Sequence(0x60, 32),
	)
	if err != nil {
		return nil, err
	}
	remote, err := pairing.CreateIdentity(
		2,
		remoteInstallationSeed,
		pairing.Sequence(0x80, 32),
		pairing.Sequence(0xa0, 32),
	)
	if err != nil {
		return nil, err
	}

	fullInvitationID := pairing.Sequence(0xc0, 16)
	fullPairID := pairing.Sequence(0xd0, 16)
	fullSecret := pairing.Sequence(0xe0, 32)
	fullHostStaticPrivate := pairing.Sequence(0x10, 32)
	fullHostStaticPublic, err := pairing.X25519Public(fullHostStaticPrivate)
	if err != nil {
		return nil, err
	}
	fullToken, err := pairing.CreateFullToken(
		fullInvitationID,
		pairingExpiry,
		hostInstallationSeed,
		fullHostStaticPublic,
		fullSecret,
	)
	if err != nil {
		return nil, err
	}

	invalidFingerprintMap, err := pairingMap(fullToken.EncodedCBOR)
	if err != nil {
		return nil, err
	}
	invalidFingerprintMap[5] = mutatePairingLast(fullToken.Fingerprint)
	invalidFingerprintCBOR, _ := pairing.EncodeCanonicalCBOR(invalidFingerprintMap)
	extraTokenFieldMap, _ := pairingMap(fullToken.EncodedCBOR)
	extraTokenFieldMap[9] = uint64(0)
	extraTokenFieldCBOR, _ := pairing.EncodeCanonicalCBOR(extraTokenFieldMap)
	invalidVersionMap, _ := pairingMap(fullToken.EncodedCBOR)
	invalidVersionMap[1] = uint64(2)
	invalidVersionCBOR, _ := pairing.EncodeCanonicalCBOR(invalidVersionMap)
	duplicateKeyCBOR := bytes.Join([][]byte{{0xa9}, fullToken.EncodedCBOR[1:], {0x01, 0x01}}, nil)
	nonShortestVersionCBOR := bytes.Join([][]byte{
		fullToken.EncodedCBOR[:2], {0x18, 0x01}, fullToken.EncodedCBOR[3:],
	}, nil)
	reorderedTokenCBOR := bytes.Join([][]byte{
		fullToken.EncodedCBOR[:1], fullToken.EncodedCBOR[3:21], fullToken.EncodedCBOR[1:3], fullToken.EncodedCBOR[21:],
	}, nil)

	invalidHostSignatureMap, _ := pairingMap(host.BundleCBOR)
	invalidHostSignatureMap[11] = mutatePairingLast(host.Signature)
	invalidHostSignatureCBOR, _ := pairing.EncodeCanonicalCBOR(invalidHostSignatureMap)
	substitutedHostRoleMap, _ := pairingMap(host.BundleCBOR)
	substitutedHostRoleMap[3] = uint64(2)
	substitutedHostRoleCBOR, _ := pairing.EncodeCanonicalCBOR(substitutedHostRoleMap)
	extraIdentityFieldMap, _ := pairingMap(remote.BundleCBOR)
	extraIdentityFieldMap[12] = uint64(0)
	extraIdentityFieldCBOR, _ := pairing.EncodeCanonicalCBOR(extraIdentityFieldMap)

	fullHandshake, err := pairingHandshake(pairingHandshakeInput{
		name: "full-token", invitationID: fullInvitationID, generation: 1, pairID: fullPairID,
		hostStaticPrivate: fullHostStaticPrivate, remoteStaticPrivate: pairing.Sequence(0x30, 32),
		hostEphemeralPrivate: pairing.Sequence(0x50, 32), remoteEphemeralPrivate: pairing.Sequence(0x70, 32),
		psk: fullToken.PSK, hostContribution: pairing.Sequence(0x90, 32), remoteContribution: pairing.Sequence(0xb0, 32),
		host: host, remote: remote,
	})
	if err != nil {
		return nil, err
	}
	shortHandshake, err := pairingHandshake(pairingHandshakeInput{
		name: "short-code", invitationID: pairing.Sequence(0x11, 16), generation: 1, pairID: pairing.Sequence(0x21, 16),
		hostStaticPrivate: pairing.Sequence(0x31, 32), remoteStaticPrivate: pairing.Sequence(0x51, 32),
		hostEphemeralPrivate: pairing.Sequence(0x71, 32), remoteEphemeralPrivate: pairing.Sequence(0x91, 32),
		hostContribution: pairing.Sequence(0xb1, 32), remoteContribution: pairing.Sequence(0xd1, 32),
		host: host, remote: remote,
	})
	if err != nil {
		return nil, err
	}

	return map[string]any{
		"schemaVersion": 1,
		"implementations": map[string]any{
			"typescript": "node:crypto",
			"go": map[string]any{
				"toolchain": "go1.26.5",
				"module":    "github.com/flynn/noise",
				"version":   "v1.1.0",
				"commit":    "4d9f71cd4ba1fe81415efac312664ccc4bc79b46",
			},
		},
		"fullToken": map[string]any{
			"acceptedAt":                   fmt.Sprintf("%d", pairingAcceptedAt),
			"expiry":                       fmt.Sprintf("%d", pairingExpiry),
			"encoded":                      fullToken.Encoded,
			"invitationIdB64":              pairing.B64(fullToken.InvitationID),
			"hostInstallationSeedB64":      pairing.B64(hostInstallationSeed),
			"hostInstallationPublicKeyB64": pairing.B64(fullToken.HostInstallationPublicKey),
			"fingerprintB64":               pairing.B64(fullToken.Fingerprint),
			"hostPairingPrivateKeyB64":     pairing.B64(fullHostStaticPrivate),
			"hostPairingPublicKeyB64":      pairing.B64(fullToken.HostPairingPublicKey),
			"fullSecretB64":                pairing.B64(fullSecret),
			"unsignedCborB64":              pairing.B64(fullToken.UnsignedCBOR),
			"signatureB64":                 pairing.B64(fullToken.Signature),
			"encodedCborB64":               pairing.B64(fullToken.EncodedCBOR),
			"pskB64":                       pairing.B64(fullToken.PSK),
		},
		"identities": map[string]any{
			"host": map[string]any{
				"installationSeedB64": pairing.B64(hostInstallationSeed),
				"bundle":              identityJSON(host),
				"unsignedCborB64":     pairing.B64(host.UnsignedCBOR),
				"bundleCborB64":       pairing.B64(host.BundleCBOR),
				"bundleHashB64":       pairing.B64(host.BundleHash),
			},
			"remote": map[string]any{
				"installationSeedB64": pairing.B64(remoteInstallationSeed),
				"bundle":              identityJSON(remote),
				"unsignedCborB64":     pairing.B64(remote.UnsignedCBOR),
				"bundleCborB64":       pairing.B64(remote.BundleCBOR),
				"bundleHashB64":       pairing.B64(remote.BundleHash),
			},
		},
		"handshakes": []any{fullHandshake, shortHandshake},
		"rejections": map[string]any{
			"canonicalCbor": []any{
				map[string]any{"name": "indefinite-map", "cborB64": pairing.B64([]byte{0xbf, 0x01, 0x01, 0xff})},
				map[string]any{"name": "non-shortest-integer", "cborB64": pairing.B64([]byte{0x18, 0x17})},
				map[string]any{"name": "duplicate-map-key", "cborB64": pairing.B64([]byte{0xa2, 0x01, 0x01, 0x01, 0x02})},
				map[string]any{"name": "reordered-map-keys", "cborB64": pairing.B64([]byte{0xa2, 0x02, 0x00, 0x01, 0x00})},
				map[string]any{"name": "negative-integer", "cborB64": pairing.B64([]byte{0x20})},
				map[string]any{"name": "invalid-utf8", "cborB64": pairing.B64([]byte{0x61, 0xff})},
				map[string]any{"name": "trailing-value", "cborB64": pairing.B64([]byte{0x01, 0x01})},
			},
			"tokens": []any{
				map[string]any{"name": "expired", "encoded": fullToken.Encoded, "now": fmt.Sprintf("%d", pairingExpiry)},
				map[string]any{"name": "wrong-prefix", "encoded": stringsReplacePrefix(fullToken.Encoded, "WF2."), "now": fmt.Sprintf("%d", pairingAcceptedAt)},
				map[string]any{"name": "padded-base64url", "encoded": fullToken.Encoded + "=", "now": fmt.Sprintf("%d", pairingAcceptedAt)},
				map[string]any{"name": "invalid-signature", "encoded": tokenFromCBOR(mutatePairingLast(fullToken.EncodedCBOR)), "now": fmt.Sprintf("%d", pairingAcceptedAt)},
				map[string]any{"name": "invalid-fingerprint", "encoded": tokenFromCBOR(invalidFingerprintCBOR), "now": fmt.Sprintf("%d", pairingAcceptedAt)},
				map[string]any{"name": "extra-field", "encoded": tokenFromCBOR(extraTokenFieldCBOR), "now": fmt.Sprintf("%d", pairingAcceptedAt)},
				map[string]any{"name": "wrong-version", "encoded": tokenFromCBOR(invalidVersionCBOR), "now": fmt.Sprintf("%d", pairingAcceptedAt)},
				map[string]any{"name": "duplicate-key", "encoded": tokenFromCBOR(duplicateKeyCBOR), "now": fmt.Sprintf("%d", pairingAcceptedAt)},
				map[string]any{"name": "non-shortest-version", "encoded": tokenFromCBOR(nonShortestVersionCBOR), "now": fmt.Sprintf("%d", pairingAcceptedAt)},
				map[string]any{"name": "reordered-keys", "encoded": tokenFromCBOR(reorderedTokenCBOR), "now": fmt.Sprintf("%d", pairingAcceptedAt)},
			},
			"identityBundles": []any{
				map[string]any{"name": "invalid-signature", "bundleCborB64": pairing.B64(invalidHostSignatureCBOR)},
				map[string]any{"name": "substituted-role", "bundleCborB64": pairing.B64(substitutedHostRoleCBOR)},
				map[string]any{"name": "extra-field", "bundleCborB64": pairing.B64(extraIdentityFieldCBOR)},
			},
			"noise": []any{
				map[string]any{"name": "wrong-invitation", "handshake": "full-token", "target": "prologue", "byteIndex": 16, "xor": 1},
				map[string]any{"name": "wrong-generation", "handshake": "full-token", "target": "prologue", "byteIndex": 39, "xor": 1},
				map[string]any{"name": "wrong-pair-id", "handshake": "full-token", "target": "prologue", "byteIndex": 40, "xor": 1},
				map[string]any{"name": "wrong-role-order", "handshake": "full-token", "target": "prologue", "byteIndex": 56, "xor": 3},
				map[string]any{"name": "wrong-psk", "handshake": "full-token", "target": "psk", "byteIndex": 0, "xor": 1},
				map[string]any{"name": "substituted-initiator-static", "handshake": "full-token", "target": "initiatorStaticPrivateKey", "byteIndex": 1, "xor": 1},
				map[string]any{"name": "substituted-responder-static", "handshake": "full-token", "target": "responderStaticPrivateKey", "byteIndex": 1, "xor": 1},
				map[string]any{"name": "substituted-host-bundle-payload", "handshake": "full-token", "target": "payload2", "byteIndex": 16, "xor": 1},
				map[string]any{"name": "tampered-message-1", "handshake": "full-token", "target": "message1", "byteIndex": 31, "xor": 1},
				map[string]any{"name": "tampered-message-2", "handshake": "full-token", "target": "message2", "byteIndex": 95, "xor": 1},
				map[string]any{"name": "tampered-message-3", "handshake": "full-token", "target": "message3", "byteIndex": 63, "xor": 1},
				map[string]any{"name": "unexpected-short-code-psk", "handshake": "short-code", "target": "addPsk", "byteIndex": 0, "xor": 1},
			},
		},
		"frozenPatterns": []string{pairing.NoiseXXPSK0Pattern, pairing.NoiseXXPattern},
	}, nil
}

func stringsReplacePrefix(value, prefix string) string {
	return prefix + value[len(pairing.FullTokenPrefix):]
}

func BuildPairingV1JSON() ([]byte, error) {
	fixture, err := BuildPairingV1Fixture()
	if err != nil {
		return nil, err
	}
	return canonicalJSON(fixture)
}
