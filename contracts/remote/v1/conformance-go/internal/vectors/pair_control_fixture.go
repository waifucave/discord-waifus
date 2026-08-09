package vectors

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
)

const (
	controlAcceptedAt uint64 = 1786270830
	controlDelayedAt         = controlAcceptedAt + 600
)

type controlRecordOptions struct {
	protocolMajor        int
	protocolMinor        int
	connectionGeneration string
	timestamp            string
	nonce                string
}

func controlHash(value []byte) []byte {
	return pairing.Hash(value)
}

func controlMutateB64(value string) (string, error) {
	decoded, err := pairing.DecodeB64(value)
	if err != nil || len(decoded) == 0 {
		return "", fmt.Errorf("invalid base64url mutation")
	}
	decoded[0] ^= 1
	return pairing.B64(decoded), nil
}

func controlRecordMap(value pairing.PairControlRecord) (map[string]any, error) {
	encoded, err := json.Marshal(value)
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

func controlCloneMap(value map[string]any) (map[string]any, error) {
	encoded, err := canonicalJSON(value)
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

func controlClonePayload(value map[string]any) (map[string]any, error) {
	return controlCloneMap(value)
}

func controlRecord(
	pairID string,
	typeValue, side, sequenceValue, nonceStart int,
	payload map[string]any,
	options controlRecordOptions,
) pairing.PairControlRecord {
	protocolMajor := options.protocolMajor
	protocolMinor := options.protocolMinor
	if protocolMajor == 0 {
		protocolMajor = 1
	}
	if options.connectionGeneration == "" {
		options.connectionGeneration = "1"
	}
	if options.timestamp == "" {
		options.timestamp = strconv.FormatUint(controlAcceptedAt, 10)
	}
	if options.nonce == "" {
		options.nonce = pairing.B64(pairing.Sequence(nonceStart, 16))
	}
	return pairing.PairControlRecord{
		Version: 1, ProtocolMajor: protocolMajor, ProtocolMinor: protocolMinor,
		PairID: pairID, Type: typeValue, Side: side,
		ConnectionGeneration: options.connectionGeneration,
		Sequence:             strconv.Itoa(sequenceValue), Timestamp: options.timestamp,
		Nonce: options.nonce, Payload: payload,
	}
}

func controlWithRevocationMAC(
	seed, key []byte,
	context pairing.PairRevocationContext,
	value pairing.PairControlRecord,
) (pairing.PairControlRecord, error) {
	value.Signature = pairing.B64(make([]byte, 64))
	mac, err := pairing.DerivePairRevocationMAC(key, value, context)
	if err != nil {
		return pairing.PairControlRecord{}, err
	}
	payload, err := controlClonePayload(value.Payload)
	if err != nil {
		return pairing.PairControlRecord{}, err
	}
	payload["revocationMac"] = pairing.B64(mac)
	value.Payload = payload
	return pairing.SignPairControlRecord(seed, value, true)
}

func controlRecordVector(
	name string,
	transport pairing.PairControlTransport,
	value pairing.PairControlRecord,
) (map[string]any, error) {
	canonical, err := pairing.CanonicalPairControlJSON(value)
	if err != nil {
		return nil, err
	}
	payload, err := pairing.PairControlPayloadJSON(value)
	if err != nil {
		return nil, err
	}
	signatureInput, err := pairing.PairControlSignatureInput(value)
	if err != nil {
		return nil, err
	}
	typeNames := []string{"", "hello", "capabilities", "endpoint_generation", "endpoint_ack", "presence", "reconnect", "revocation", "revocation_ack", "error"}
	return map[string]any{
		"name": name, "typeName": typeNames[value.Type], "typeByte": value.Type,
		"ingressTransport": string(transport), "value": value,
		"canonicalBytesB64": pairing.B64(canonical),
		"payloadBytesB64":   pairing.B64(payload),
		"payloadSha256B64":  pairing.B64(controlHash(payload)),
		"signatureInputB64": pairing.B64(signatureInput),
	}, nil
}

func controlRejection(name string, payload []byte, code string, side ...int) map[string]any {
	result := map[string]any{
		"name": name, "payloadB64": pairing.B64(payload), "errorCode": code,
	}
	selectedSide := 1
	if len(side) > 0 {
		selectedSide = side[0]
	}
	result["side"] = selectedSide
	return result
}

func controlStateRejection(name string, value pairing.PairControlRecord, transport pairing.PairControlTransport, code string) (map[string]any, error) {
	encoded, err := pairing.CanonicalPairControlJSON(value)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"name": name, "payloadB64": pairing.B64(encoded), "transport": string(transport), "errorCode": code,
	}, nil
}

func BuildPairControlV1Fixture() (map[string]any, error) {
	pairingFixture, err := BuildPairingV1Fixture()
	if err != nil {
		return nil, err
	}
	identities, err := fixtureObject(pairingFixture["identities"], "pairing identities")
	if err != nil {
		return nil, err
	}
	hostIdentity, err := fixtureObject(identities["host"], "host identity")
	if err != nil {
		return nil, err
	}
	remoteIdentity, err := fixtureObject(identities["remote"], "remote identity")
	if err != nil {
		return nil, err
	}
	hostBundle, err := fixtureObject(hostIdentity["bundle"], "host bundle")
	if err != nil {
		return nil, err
	}
	remoteBundle, err := fixtureObject(remoteIdentity["bundle"], "remote bundle")
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
	pairContext, err := fixtureObject(full["pairContext"], "pair context")
	if err != nil {
		return nil, err
	}
	derived, err := fixtureObject(full["derived"], "derived keys")
	if err != nil {
		return nil, err
	}
	pairID, err := fixtureString(pairContext["pairIdB64"], "pair ID")
	if err != nil {
		return nil, err
	}
	hostSeedText, err := fixtureString(hostIdentity["installationSeedB64"], "host seed")
	if err != nil {
		return nil, err
	}
	remoteSeedText, err := fixtureString(remoteIdentity["installationSeedB64"], "remote seed")
	if err != nil {
		return nil, err
	}
	hostSeed, err := pairing.DecodeB64(hostSeedText)
	if err != nil {
		return nil, err
	}
	remoteSeed, err := pairing.DecodeB64(remoteSeedText)
	if err != nil {
		return nil, err
	}
	revocationKeyText, err := fixtureString(derived["revocationKeyB64"], "revocation key")
	if err != nil {
		return nil, err
	}
	confirmationKeyText, err := fixtureString(derived["confirmationKeyB64"], "confirmation key")
	if err != nil {
		return nil, err
	}
	revocationKey, err := pairing.DecodeB64(revocationKeyText)
	if err != nil {
		return nil, err
	}
	confirmationKey, err := pairing.DecodeB64(confirmationKeyText)
	if err != nil {
		return nil, err
	}
	hostHash, err := fixtureString(pairContext["hostBundleHashB64"], "host bundle hash")
	if err != nil {
		return nil, err
	}
	remoteHash, err := fixtureString(pairContext["remoteBundleHashB64"], "remote bundle hash")
	if err != nil {
		return nil, err
	}
	hostTrustEpoch, err := fixtureString(hostBundle["trustEpoch"], "host trust epoch")
	if err != nil {
		return nil, err
	}
	remoteTrustEpoch, err := fixtureString(remoteBundle["trustEpoch"], "remote trust epoch")
	if err != nil {
		return nil, err
	}
	revocationContext := pairing.PairRevocationContext{
		PairID: pairID, HostBundleHash: hostHash, RemoteBundleHash: remoteHash,
		HostTrustEpoch: hostTrustEpoch, RemoteTrustEpoch: remoteTrustEpoch,
	}
	endpointCiphertext := pairing.Sequence(0xb0, 32)
	endpointHash := pairing.B64(controlHash(endpointCiphertext))
	capabilitiesHash := pairing.B64(controlHash([]byte("waifus-capabilities-v1")))
	revocationNonce := pairing.B64(pairing.Sequence(0x77, 16))

	unsigned := []pairing.PairControlRecord{
		controlRecord(pairID, 1, 1, 1, 0x11, map[string]any{
			"resumeConnectionGeneration": "0", "resumeSequence": "0",
		}, controlRecordOptions{}),
		controlRecord(pairID, 2, 1, 2, 0x22, map[string]any{
			"capabilitiesSha256": capabilitiesHash, "coordinationMinor": 0,
		}, controlRecordOptions{}),
		controlRecord(pairID, 3, 1, 3, 0x33, map[string]any{
			"endpointEpoch": "1", "ciphertext": pairing.B64(endpointCiphertext), "ciphertextSha256": endpointHash,
		}, controlRecordOptions{}),
		controlRecord(pairID, 4, 1, 4, 0x44, map[string]any{
			"endpointEpoch": "1", "ciphertextSha256": endpointHash,
		}, controlRecordOptions{}),
		controlRecord(pairID, 5, 1, 5, 0x55, map[string]any{
			"state": "online", "validUntil": strconv.FormatUint(controlAcceptedAt+300, 10),
		}, controlRecordOptions{}),
		controlRecord(pairID, 6, 1, 6, 0x66, map[string]any{
			"lastReceivedConnectionGeneration": "1", "lastReceivedSequence": "4",
		}, controlRecordOptions{}),
		controlRecord(pairID, 7, 1, 7, 0x77, map[string]any{
			"revocationEpoch": "3", "reason": "user_revoked", "revocationMac": pairing.B64(make([]byte, 32)),
		}, controlRecordOptions{nonce: revocationNonce}),
		controlRecord(pairID, 8, 2, 1, 0x77, map[string]any{
			"revocationEpoch": "3", "revocationMac": pairing.B64(make([]byte, 32)),
		}, controlRecordOptions{nonce: revocationNonce}),
		controlRecord(pairID, 9, 2, 2, 0x99, map[string]any{
			"code": "resync_required", "forConnectionGeneration": "1", "forSequence": "7",
		}, controlRecordOptions{}),
	}
	records := make([]pairing.PairControlRecord, len(unsigned))
	for index, value := range unsigned {
		seed := hostSeed
		if value.Side == 2 {
			seed = remoteSeed
		}
		if index == 6 || index == 7 {
			records[index], err = controlWithRevocationMAC(seed, revocationKey, revocationContext, value)
		} else {
			records[index], err = pairing.SignPairControlRecord(seed, value, true)
		}
		if err != nil {
			return nil, err
		}
	}
	transports := []pairing.PairControlTransport{
		pairing.ControlHTTPSPublish, pairing.ControlHTTPSPublish, pairing.ControlHTTPSPublish,
		pairing.ControlHTTPSPublish, pairing.ControlWebSocket, pairing.ControlWebSocket,
		pairing.ControlHTTPSRevoke, pairing.ControlHTTPSRevokeAck, pairing.ControlHTTPSPublish,
	}
	names := []string{"hello", "capabilities", "endpoint-generation", "endpoint-ack", "presence", "reconnect", "revocation", "revocation-ack", "error"}
	vectors := make([]any, len(records))
	for index, record := range records {
		vector, err := controlRecordVector(names[index], transports[index], record)
		if err != nil {
			return nil, err
		}
		vectors[index] = vector
	}

	helloMap, err := controlRecordMap(records[0])
	if err != nil {
		return nil, err
	}
	rejections := make([]any, 0, 17)
	invalidSignature, err := controlCloneMap(helloMap)
	if err != nil {
		return nil, err
	}
	invalidSignature["signature"], err = controlMutateB64(invalidSignature["signature"].(string))
	if err != nil {
		return nil, err
	}
	raw, err := canonicalJSON(invalidSignature)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, controlRejection("invalid-signature", raw, "invalid_signature"))

	typeMismatch, err := controlCloneMap(helloMap)
	if err != nil {
		return nil, err
	}
	typeMismatch["type"] = 2
	raw, err = canonicalJSON(typeMismatch)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, controlRejection("type-payload-mismatch", raw, "invalid_record"))
	payloadSubstitution, err := controlCloneMap(helloMap)
	if err != nil {
		return nil, err
	}
	payloadSubstitution["payload"].(map[string]any)["resumeSequence"] = "1"
	raw, err = canonicalJSON(payloadSubstitution)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, controlRejection("payload-substitution", raw, "invalid_signature"))
	sideSubstitution, err := controlCloneMap(helloMap)
	if err != nil {
		return nil, err
	}
	sideSubstitution["side"] = 2
	raw, err = canonicalJSON(sideSubstitution)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, controlRejection("side-substitution", raw, "invalid_signature", 2))
	nonceSubstitution, err := controlCloneMap(helloMap)
	if err != nil {
		return nil, err
	}
	nonceSubstitution["nonce"] = pairing.B64(pairing.Sequence(0xf0, 16))
	raw, err = canonicalJSON(nonceSubstitution)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, controlRejection("nonce-substitution", raw, "invalid_signature"))
	helloBytes, err := pairing.CanonicalPairControlJSON(records[0])
	if err != nil {
		return nil, err
	}
	rejections = append(rejections,
		map[string]any{"name": "wrong-authenticated-side", "payloadB64": pairing.B64(helloBytes), "errorCode": "wrong_side", "keySide": 1, "expectedSide": 2},
		map[string]any{"name": "wrong-installation-key", "payloadB64": pairing.B64(helloBytes), "errorCode": "invalid_signature", "keySide": 2, "expectedSide": 1},
	)
	extraField, err := controlCloneMap(helloMap)
	if err != nil {
		return nil, err
	}
	extraField["recordType"] = "hello"
	raw, err = canonicalJSON(extraField)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, controlRejection("extra-field", raw, "invalid_record"))
	missingSignature, err := controlCloneMap(helloMap)
	if err != nil {
		return nil, err
	}
	delete(missingSignature, "signature")
	raw, err = canonicalJSON(missingSignature)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, controlRejection("missing-signature", raw, "invalid_record"))
	rejections = append(rejections, controlRejection("noncanonical-leading-whitespace", append([]byte{' '}, helloBytes...), "invalid_canonical_payload"))

	wrongPair := records[0]
	wrongPair.Payload, err = controlClonePayload(records[0].Payload)
	if err != nil {
		return nil, err
	}
	wrongPair.PairID, err = controlMutateB64(pairID)
	if err != nil {
		return nil, err
	}
	wrongPair, err = pairing.SignPairControlRecord(hostSeed, wrongPair, false)
	if err != nil {
		return nil, err
	}
	raw, err = pairing.CanonicalPairControlJSON(wrongPair)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, controlRejection("wrong-pair", raw, "wrong_pair"))
	wrongProtocol := records[0]
	wrongProtocol.Payload, err = controlClonePayload(records[0].Payload)
	if err != nil {
		return nil, err
	}
	wrongProtocol.ProtocolMinor = 1
	wrongProtocol, err = pairing.SignPairControlRecord(hostSeed, wrongProtocol, false)
	if err != nil {
		return nil, err
	}
	raw, err = pairing.CanonicalPairControlJSON(wrongProtocol)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, controlRejection("protocol-mismatch", raw, "protocol_mismatch"))
	staleTimestamp := records[0]
	staleTimestamp.Payload, err = controlClonePayload(records[0].Payload)
	if err != nil {
		return nil, err
	}
	staleTimestamp.Timestamp = strconv.FormatUint(controlAcceptedAt-61, 10)
	staleTimestamp, err = pairing.SignPairControlRecord(hostSeed, staleTimestamp, false)
	if err != nil {
		return nil, err
	}
	raw, err = pairing.CanonicalPairControlJSON(staleTimestamp)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, controlRejection("stale-first-ingress-timestamp", raw, "timestamp_out_of_window"))
	futureTimestamp := records[0]
	futureTimestamp.Payload, err = controlClonePayload(records[0].Payload)
	if err != nil {
		return nil, err
	}
	futureTimestamp.Timestamp = strconv.FormatUint(controlAcceptedAt+61, 10)
	futureTimestamp, err = pairing.SignPairControlRecord(hostSeed, futureTimestamp, false)
	if err != nil {
		return nil, err
	}
	raw, err = pairing.CanonicalPairControlJSON(futureTimestamp)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, controlRejection("future-first-ingress-timestamp", raw, "timestamp_out_of_window"))
	badEndpointHash := records[2]
	badEndpointHash.Payload, err = controlClonePayload(records[2].Payload)
	if err != nil {
		return nil, err
	}
	badEndpointHash.Payload["ciphertextSha256"], err = controlMutateB64(badEndpointHash.Payload["ciphertextSha256"].(string))
	if err != nil {
		return nil, err
	}
	badEndpointHash, err = pairing.SignPairControlRecord(hostSeed, badEndpointHash, false)
	if err != nil {
		return nil, err
	}
	raw, err = pairing.CanonicalPairControlJSON(badEndpointHash)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, controlRejection("endpoint-ciphertext-hash-mismatch", raw, "invalid_payload_hash"))
	oversizedCiphertextMap, err := controlRecordMap(records[2])
	if err != nil {
		return nil, err
	}
	oversizedPayload := oversizedCiphertextMap["payload"].(map[string]any)
	oversizedCiphertext := bytes.Repeat([]byte{0xa6}, 1201)
	oversizedPayload["ciphertext"] = pairing.B64(oversizedCiphertext)
	oversizedPayload["ciphertextSha256"] = pairing.B64(controlHash(oversizedCiphertext))
	raw, err = canonicalJSON(oversizedCiphertextMap)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, controlRejection("endpoint-ciphertext-1201-bytes", raw, "invalid_record"))
	missingMACMap, err := controlRecordMap(records[6])
	if err != nil {
		return nil, err
	}
	delete(missingMACMap["payload"].(map[string]any), "revocationMac")
	raw, err = canonicalJSON(missingMACMap)
	if err != nil {
		return nil, err
	}
	rejections = append(rejections, controlRejection("missing-revocation-mac", raw, "invalid_record"))

	maximumCiphertext := bytes.Repeat([]byte{0xa5}, 1200)
	maximumRecord, err := pairing.SignPairControlRecord(hostSeed, controlRecord(pairID, 3, 1, 1, 0xa1, map[string]any{
		"endpointEpoch": "1", "ciphertext": pairing.B64(maximumCiphertext), "ciphertextSha256": pairing.B64(controlHash(maximumCiphertext)),
	}, controlRecordOptions{}), true)
	if err != nil {
		return nil, err
	}
	maximumBytes, err := pairing.CanonicalPairControlJSON(maximumRecord)
	if err != nil {
		return nil, err
	}

	tupleConflict := records[8]
	tupleConflict.Payload, err = controlClonePayload(records[8].Payload)
	if err != nil {
		return nil, err
	}
	tupleConflict.Payload["code"] = "revoked"
	tupleConflict, err = pairing.SignPairControlRecord(remoteSeed, tupleConflict, false)
	if err != nil {
		return nil, err
	}
	nonceReuse, err := pairing.SignPairControlRecord(hostSeed, controlRecord(pairID, 1, 1, 8, 0x11, map[string]any{
		"resumeConnectionGeneration": "1", "resumeSequence": "7",
	}, controlRecordOptions{nonce: records[0].Nonce}), true)
	if err != nil {
		return nil, err
	}
	badGenerationStart, err := pairing.SignPairControlRecord(hostSeed, controlRecord(pairID, 1, 1, 2, 0xc1, map[string]any{
		"resumeConnectionGeneration": "1", "resumeSequence": "7",
	}, controlRecordOptions{connectionGeneration: "2"}), true)
	if err != nil {
		return nil, err
	}
	generationAdvance, err := pairing.SignPairControlRecord(hostSeed, controlRecord(pairID, 1, 1, 1, 0xc2, map[string]any{
		"resumeConnectionGeneration": "1", "resumeSequence": "7",
	}, controlRecordOptions{connectionGeneration: "2"}), true)
	if err != nil {
		return nil, err
	}
	staleGeneration, err := pairing.SignPairControlRecord(hostSeed, controlRecord(pairID, 1, 1, 8, 0xd2, map[string]any{
		"resumeConnectionGeneration": "1", "resumeSequence": "7",
	}, controlRecordOptions{}), true)
	if err != nil {
		return nil, err
	}
	stateVectors := make([]any, 0, 4)
	for _, input := range []struct {
		name      string
		value     pairing.PairControlRecord
		transport pairing.PairControlTransport
		code      string
	}{
		{"stale-sequence", records[5], pairing.ControlWebSocket, "stale_sequence"},
		{"same-tuple-different-bytes", tupleConflict, pairing.ControlHTTPSPublish, "tuple_conflict"},
		{"reused-side-nonce", nonceReuse, pairing.ControlWebSocket, "nonce_reused"},
		{"higher-generation-not-sequence-one", badGenerationStart, pairing.ControlWebSocket, "invalid_generation_start"},
		{"poll-is-delivery-only", records[8], pairing.ControlHTTPSPoll, "wrong_transport"},
	} {
		vector, err := controlStateRejection(input.name, input.value, input.transport, input.code)
		if err != nil {
			return nil, err
		}
		stateVectors = append(stateVectors, vector)
	}

	wrongMAC := records[6]
	wrongMAC.Payload, err = controlClonePayload(records[6].Payload)
	if err != nil {
		return nil, err
	}
	wrongMAC.Payload["revocationMac"], err = controlMutateB64(wrongMAC.Payload["revocationMac"].(string))
	if err != nil {
		return nil, err
	}
	wrongMAC, err = pairing.SignPairControlRecord(hostSeed, wrongMAC, false)
	if err != nil {
		return nil, err
	}
	revocationRejections := make([]any, 0, 13)
	addRevocation := func(name string, value pairing.PairControlRecord, key []byte, context *pairing.PairRevocationContext) {
		vector := map[string]any{"name": name, "value": value}
		if key != nil {
			vector["keyB64"] = pairing.B64(key)
		}
		if context != nil {
			vector["context"] = *context
		}
		revocationRejections = append(revocationRejections, vector)
	}
	addRevocation("wrong-mac", wrongMAC, nil, nil)
	addRevocation("confirmation-key-reuse", records[6], confirmationKey, nil)
	for _, input := range []struct {
		name   string
		mutate func(*pairing.PairControlRecord)
	}{
		{"revocation-epoch", func(value *pairing.PairControlRecord) { value.Payload["revocationEpoch"] = "4" }},
		{"revocation-reason", func(value *pairing.PairControlRecord) { value.Payload["reason"] = "identity_reset" }},
		{"revocation-nonce", func(value *pairing.PairControlRecord) { value.Nonce = pairing.B64(pairing.Sequence(0xd1, 16)) }},
		{"revocation-side", func(value *pairing.PairControlRecord) { value.Side = 2 }},
	} {
		value := records[6]
		value.Payload, err = controlClonePayload(records[6].Payload)
		if err != nil {
			return nil, err
		}
		input.mutate(&value)
		seed := hostSeed
		if value.Side == 2 {
			seed = remoteSeed
		}
		value, err = pairing.SignPairControlRecord(seed, value, false)
		if err != nil {
			return nil, err
		}
		addRevocation(input.name, value, nil, nil)
	}
	mutatedPairID, err := controlMutateB64(pairID)
	if err != nil {
		return nil, err
	}
	mutatedHostHash, err := controlMutateB64(hostHash)
	if err != nil {
		return nil, err
	}
	mutatedRemoteHash, err := controlMutateB64(remoteHash)
	if err != nil {
		return nil, err
	}
	for _, input := range []struct {
		name  string
		field string
		value string
	}{
		{"context-pair", "pair", mutatedPairID},
		{"context-host-bundle", "host", mutatedHostHash},
		{"context-remote-bundle", "remote", mutatedRemoteHash},
		{"context-host-trust-epoch", "hostEpoch", "3"},
		{"context-remote-trust-epoch", "remoteEpoch", "4"},
	} {
		context := revocationContext
		switch input.field {
		case "pair":
			context.PairID = input.value
		case "host":
			context.HostBundleHash = input.value
		case "remote":
			context.RemoteBundleHash = input.value
		case "hostEpoch":
			context.HostTrustEpoch = input.value
		case "remoteEpoch":
			context.RemoteTrustEpoch = input.value
		}
		addRevocation(input.name, records[6], nil, &context)
	}
	ackEpoch := records[7]
	ackEpoch.Payload, err = controlClonePayload(records[7].Payload)
	if err != nil {
		return nil, err
	}
	ackEpoch.Payload["revocationEpoch"] = "4"
	ackEpoch, err = pairing.SignPairControlRecord(remoteSeed, ackEpoch, false)
	if err != nil {
		return nil, err
	}
	addRevocation("ack-revocation-epoch", ackEpoch, nil, nil)
	ackNonce := records[7]
	ackNonce.Payload, err = controlClonePayload(records[7].Payload)
	if err != nil {
		return nil, err
	}
	ackNonce.Nonce = pairing.B64(pairing.Sequence(0xe1, 16))
	ackNonce, err = pairing.SignPairControlRecord(remoteSeed, ackNonce, false)
	if err != nil {
		return nil, err
	}
	addRevocation("ack-record-nonce", ackNonce, nil, nil)

	hostPublic, err := pairing.Ed25519Public(hostSeed)
	if err != nil {
		return nil, err
	}
	remotePublic, err := pairing.Ed25519Public(remoteSeed)
	if err != nil {
		return nil, err
	}
	revocationInput, err := pairing.PairRevocationMACInput(records[6], revocationContext)
	if err != nil {
		return nil, err
	}
	ackInput, err := pairing.PairRevocationAckMACInput(records[7], revocationContext)
	if err != nil {
		return nil, err
	}
	wrongMACVector, err := controlRecordVector("worker-opaque-wrong-revocation-mac", pairing.ControlHTTPSRevoke, wrongMAC)
	if err != nil {
		return nil, err
	}
	generationAdvanceBytes, err := pairing.CanonicalPairControlJSON(generationAdvance)
	if err != nil {
		return nil, err
	}
	staleGenerationBytes, err := pairing.CanonicalPairControlJSON(staleGeneration)
	if err != nil {
		return nil, err
	}

	return map[string]any{
		"schemaVersion":          1,
		"acceptedAt":             strconv.FormatUint(controlAcceptedAt, 10),
		"delayedAt":              strconv.FormatUint(controlDelayedAt, 10),
		"installationSeeds":      map[string]any{"host": pairing.B64(hostSeed), "remote": pairing.B64(remoteSeed)},
		"installationPublicKeys": map[string]any{"host": pairing.B64(hostPublic), "remote": pairing.B64(remotePublic)},
		"context":                map[string]any{"pairId": pairID, "protocolMajor": 1, "protocolMinor": 0},
		"records":                vectors,
		"transportMatrix": map[string]any{
			"websocket":     []int{1, 2, 3, 4, 5, 6, 7, 8, 9},
			"https_publish": []int{1, 2, 3, 4, 5, 6, 9},
			"https_revoke":  []int{7}, "https_revocation_ack": []int{8},
			"https_poll": []int{1, 2, 3, 4, 5, 6, 7, 8, 9},
		},
		"rejections": rejections, "stateRejections": stateVectors,
		"generationTransition": map[string]any{
			"advancePayloadB64": pairing.B64(generationAdvanceBytes), "stalePayloadB64": pairing.B64(staleGenerationBytes),
		},
		"boundary": map[string]any{
			"maximumDecodedCiphertextBytes": 1200, "maximumRecordBytes": len(maximumBytes),
			"maximumRecordB64": pairing.B64(maximumBytes), "maximumRecord": maximumRecord,
			"rawRecordLimit": 2048, "overLimitPayloadB64": pairing.B64(bytes.Repeat([]byte{0x20}, 2049)),
		},
		"revocation": map[string]any{
			"revocationKeyB64": pairing.B64(revocationKey), "confirmationKeyB64": pairing.B64(confirmationKey),
			"context": revocationContext, "revocationMacInputB64": pairing.B64(revocationInput),
			"revocationAckMacInputB64": pairing.B64(ackInput), "rejections": revocationRejections,
			"workerOpaqueWrongMac": wrongMACVector,
		},
	}, nil
}

func BuildPairControlV1JSON() ([]byte, error) {
	fixture, err := BuildPairControlV1Fixture()
	if err != nil {
		return nil, err
	}
	return canonicalJSON(fixture)
}
