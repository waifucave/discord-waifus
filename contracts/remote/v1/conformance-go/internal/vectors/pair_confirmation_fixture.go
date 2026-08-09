package vectors

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
)

func fixtureObject(value any, name string) (map[string]any, error) {
	result, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s is not fixture object", name)
	}
	return result, nil
}

func fixtureString(value any, name string) (string, error) {
	result, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("%s is not fixture string", name)
	}
	return result, nil
}

func confirmationMap(value pairing.PairConfirmation) (map[string]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err := json.Unmarshal(encoded, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func cloneConfirmationMap(value map[string]any) map[string]any {
	result := make(map[string]any, len(value))
	for key, field := range value {
		result[key] = field
	}
	return result
}

func mutateConfirmationB64(value string, index int) (string, error) {
	decoded, err := pairing.DecodeB64(value)
	if err != nil || index < 0 || index >= len(decoded) {
		return "", fmt.Errorf("invalid confirmation mutation")
	}
	decoded[index] ^= 1
	return pairing.B64(decoded), nil
}

func confirmationRejection(name string, value any, errorCode string, keyB64 ...string) (map[string]any, error) {
	payload, err := canonicalJSON(value)
	if err != nil {
		return nil, err
	}
	result := map[string]any{
		"name":       name,
		"payloadB64": pairing.B64(payload),
		"errorCode":  errorCode,
	}
	if len(keyB64) > 0 {
		result["keyB64"] = keyB64[0]
	}
	return result, nil
}

func BuildPairConfirmationV1Fixture() (map[string]any, error) {
	pairingFixture, err := BuildPairingV1Fixture()
	if err != nil {
		return nil, err
	}
	handshakes, ok := pairingFixture["handshakes"].([]any)
	if !ok {
		return nil, fmt.Errorf("pairing handshakes missing")
	}
	var full map[string]any
	for _, candidate := range handshakes {
		value, err := fixtureObject(candidate, "handshake")
		if err != nil {
			return nil, err
		}
		if value["name"] == "full-token" {
			full = value
			break
		}
	}
	if full == nil {
		return nil, fmt.Errorf("full-token handshake missing")
	}
	context, err := fixtureObject(full["pairContext"], "pair context")
	if err != nil {
		return nil, err
	}
	derived, err := fixtureObject(full["derived"], "derived keys")
	if err != nil {
		return nil, err
	}
	confirmationKeyB64, err := fixtureString(derived["confirmationKeyB64"], "confirmation key")
	if err != nil {
		return nil, err
	}
	confirmationKey, err := pairing.DecodeB64(confirmationKeyB64)
	if err != nil {
		return nil, err
	}
	invitationID, err := fixtureString(context["invitationIdB64"], "invitation ID")
	if err != nil {
		return nil, err
	}
	generation, err := fixtureString(context["invitationGeneration"], "invitation generation")
	if err != nil {
		return nil, err
	}
	pairID, err := fixtureString(context["pairIdB64"], "pair ID")
	if err != nil {
		return nil, err
	}
	transcriptHash, err := fixtureString(full["transcriptHashB64"], "transcript hash")
	if err != nil {
		return nil, err
	}
	channelBinding, err := fixtureString(full["channelBindingB64"], "channel binding")
	if err != nil {
		return nil, err
	}
	hostBundleHash, err := fixtureString(context["hostBundleHashB64"], "host bundle hash")
	if err != nil {
		return nil, err
	}
	remoteBundleHash, err := fixtureString(context["remoteBundleHashB64"], "remote bundle hash")
	if err != nil {
		return nil, err
	}
	base := pairing.PairConfirmation{
		Version: 1, InvitationID: invitationID, InvitationGeneration: generation, PairID: pairID,
		TranscriptHash: transcriptHash, ChannelBinding: channelBinding,
		HostBundleHash: hostBundleHash, RemoteBundleHash: remoteBundleHash,
		ApprovalContextHash: pairing.B64(pairing.Sequence(0x55, 32)),
	}
	hostUnsigned := base
	hostUnsigned.Side = 1
	hostUnsigned.ConfirmationNonce = pairing.B64(pairing.Sequence(0x61, 16))
	remoteUnsigned := base
	remoteUnsigned.Side = 2
	remoteUnsigned.ConfirmationNonce = pairing.B64(pairing.Sequence(0x71, 16))
	host, err := pairing.CreatePairConfirmation(confirmationKey, hostUnsigned)
	if err != nil {
		return nil, err
	}
	remote, err := pairing.CreatePairConfirmation(confirmationKey, remoteUnsigned)
	if err != nil {
		return nil, err
	}
	hostMap, err := confirmationMap(host)
	if err != nil {
		return nil, err
	}
	remoteMap, err := confirmationMap(remote)
	if err != nil {
		return nil, err
	}
	hostBytes, err := pairing.CanonicalPairConfirmationJSON(host)
	if err != nil {
		return nil, err
	}
	remoteBytes, err := pairing.CanonicalPairConfirmationJSON(remote)
	if err != nil {
		return nil, err
	}
	hostMACInput, err := pairing.PairConfirmationMACInput(hostUnsigned)
	if err != nil {
		return nil, err
	}
	remoteMACInput, err := pairing.PairConfirmationMACInput(remoteUnsigned)
	if err != nil {
		return nil, err
	}

	type substitution struct {
		name         string
		field        string
		value        any
		mutateSource string
	}
	substitutions := []substitution{
		{name: "invitation-id", field: "invitationId", mutateSource: host.InvitationID},
		{name: "invitation-generation", field: "invitationGeneration", value: "2"},
		{name: "pair-id", field: "pairId", mutateSource: host.PairID},
		{name: "side", field: "side", value: 2},
		{name: "transcript-hash", field: "transcriptHash", mutateSource: host.TranscriptHash},
		{name: "channel-binding", field: "channelBinding", mutateSource: host.ChannelBinding},
		{name: "host-bundle-hash", field: "hostBundleHash", mutateSource: host.HostBundleHash},
		{name: "remote-bundle-hash", field: "remoteBundleHash", mutateSource: host.RemoteBundleHash},
		{name: "approval-context-hash", field: "approvalContextHash", mutateSource: host.ApprovalContextHash},
		{name: "confirmation-nonce", field: "confirmationNonce", mutateSource: host.ConfirmationNonce},
	}
	rejections := make([]any, 0, len(substitutions)+7)
	for _, substitution := range substitutions {
		replacement := substitution.value
		if substitution.mutateSource != "" {
			replacement, err = mutateConfirmationB64(substitution.mutateSource, 0)
			if err != nil {
				return nil, err
			}
		}
		value := cloneConfirmationMap(hostMap)
		value[substitution.field] = replacement
		vector, err := confirmationRejection("substituted-"+substitution.name, value, "invalid_mac")
		if err != nil {
			return nil, err
		}
		rejections = append(rejections, vector)
	}
	wrongMAC := cloneConfirmationMap(hostMap)
	wrongMAC["confirmationMac"], err = mutateConfirmationB64(host.ConfirmationMAC, 0)
	if err != nil {
		return nil, err
	}
	vector, err := confirmationRejection("wrong-mac", wrongMAC, "invalid_mac")
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, vector)
	extraField := cloneConfirmationMap(hostMap)
	extraField["recordType"] = "pair_confirmation"
	vector, err = confirmationRejection("extra-field", extraField, "invalid_record")
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, vector)
	missingField := cloneConfirmationMap(hostMap)
	delete(missingField, "approvalContextHash")
	vector, err = confirmationRejection("missing-field", missingField, "invalid_record")
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, vector)
	numericGeneration := cloneConfirmationMap(hostMap)
	numericGeneration["invitationGeneration"] = 1
	vector, err = confirmationRejection("numeric-generation", numericGeneration, "invalid_record")
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, vector)
	selfPair := cloneConfirmationMap(hostMap)
	selfPair["remoteBundleHash"] = selfPair["hostBundleHash"]
	vector, err = confirmationRejection("identical-bundle-hashes", selfPair, "invalid_record")
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, vector)
	wrongKeyB64 := pairing.B64(pairing.Sequence(0x91, 32))
	vector, err = confirmationRejection("wrong-confirmation-key", hostMap, "invalid_mac", wrongKeyB64)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, vector)
	rejections = append(rejections, map[string]any{
		"name":       "noncanonical-leading-whitespace",
		"payloadB64": pairing.B64(append([]byte{' '}, hostBytes...)),
		"errorCode":  "invalid_canonical_payload",
	})

	return map[string]any{
		"schemaVersion":      1,
		"confirmationKeyB64": confirmationKeyB64,
		"records": map[string]any{
			"host": map[string]any{
				"value": hostMap, "canonicalBytesB64": pairing.B64(hostBytes), "macInputB64": pairing.B64(hostMACInput),
			},
			"remote": map[string]any{
				"value": remoteMap, "canonicalBytesB64": pairing.B64(remoteBytes), "macInputB64": pairing.B64(remoteMACInput),
			},
		},
		"rejections": rejections,
		"boundary": map[string]any{
			"maximumPayloadBytes": 1_024,
			"atLimitPayloadB64":   pairing.B64(bytes.Repeat([]byte{0x20}, 1_024)),
			"atLimitOutcome":      "invalid_canonical_payload",
			"overLimitPayloadB64": pairing.B64(bytes.Repeat([]byte{0x20}, 1_025)),
			"overLimitOutcome":    "payload_too_large",
		},
		"ordering": map[string]any{
			"valid":      []string{"approve", "publish_local", "poll_verify_peer", "consume"},
			"idempotent": []string{"publish_same_local", "verify_same_peer", "consume_same"},
			"rejected": []string{
				"publish_pre_approval", "verify_before_local_publish", "noise_transport_record_type",
				"consume_before_peer_verify", "different_second_confirmation", "publish_post_consume",
				"publish_post_cancel", "publish_post_expiry",
			},
		},
	}, nil
}

func BuildPairConfirmationV1JSON() ([]byte, error) {
	fixture, err := BuildPairConfirmationV1Fixture()
	if err != nil {
		return nil, err
	}
	return canonicalJSON(fixture)
}
