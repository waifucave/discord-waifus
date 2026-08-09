package pairing

import (
	"bytes"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

const (
	PairControlRecordMax = 2048
	PairControlClockSkew = uint64(60)
)

var pairControlTypeNames = map[int]string{
	1: "hello",
	2: "capabilities",
	3: "endpoint_generation",
	4: "endpoint_ack",
	5: "presence",
	6: "reconnect",
	7: "revocation",
	8: "revocation_ack",
	9: "error",
}

type ControlError struct {
	Code   string
	Detail string
}

func (e *ControlError) Error() string {
	return e.Code + ": " + e.Detail
}

func controlFailure(code, detail string) error {
	return &ControlError{Code: code, Detail: detail}
}

type PairControlRecord struct {
	Version              int            `json:"version"`
	ProtocolMajor        int            `json:"protocolMajor"`
	ProtocolMinor        int            `json:"protocolMinor"`
	PairID               string         `json:"pairId"`
	Type                 int            `json:"type"`
	Side                 int            `json:"side"`
	ConnectionGeneration string         `json:"connectionGeneration"`
	Sequence             string         `json:"sequence"`
	Timestamp            string         `json:"timestamp"`
	Nonce                string         `json:"nonce"`
	Payload              map[string]any `json:"payload"`
	Signature            string         `json:"signature"`
}

func pairControlRecordMap(value PairControlRecord, includeSignature bool) map[string]any {
	result := map[string]any{
		"version":              value.Version,
		"protocolMajor":        value.ProtocolMajor,
		"protocolMinor":        value.ProtocolMinor,
		"pairId":               value.PairID,
		"type":                 value.Type,
		"side":                 value.Side,
		"connectionGeneration": value.ConnectionGeneration,
		"sequence":             value.Sequence,
		"timestamp":            value.Timestamp,
		"nonce":                value.Nonce,
		"payload":              value.Payload,
	}
	if includeSignature {
		result["signature"] = value.Signature
	}
	return result
}

func canonicalPairControlJSON(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var generic any
	if err := decoder.Decode(&generic); err != nil {
		return nil, err
	}
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(generic); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(output.Bytes(), []byte{'\n'}), nil
}

func CanonicalPairControlJSON(value PairControlRecord) ([]byte, error) {
	if err := ValidatePairControlRecord(value, true); err != nil {
		return nil, err
	}
	return canonicalPairControlJSON(pairControlRecordMap(value, true))
}

func PairControlPayloadJSON(value PairControlRecord) ([]byte, error) {
	if err := ValidatePairControlRecord(value, false); err != nil {
		return nil, err
	}
	return canonicalPairControlJSON(value.Payload)
}

func exactObject(value map[string]any, expected ...string) error {
	if len(value) != len(expected) {
		return fmt.Errorf("object has %d fields, expected %d", len(value), len(expected))
	}
	for _, name := range expected {
		if _, ok := value[name]; !ok {
			return fmt.Errorf("object is missing %s", name)
		}
	}
	return nil
}

func controlString(value any, name string) (string, error) {
	result, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("%s must be a string", name)
	}
	return result, nil
}

func controlInt(value any, name string, maximum int) (int, error) {
	var text string
	switch candidate := value.(type) {
	case int:
		text = strconv.Itoa(candidate)
	case json.Number:
		text = candidate.String()
	default:
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	if text == "" || strings.TrimLeft(text, "0123456789") != "" || (len(text) > 1 && text[0] == '0') {
		return 0, fmt.Errorf("%s must be a canonical nonnegative integer", name)
	}
	parsed, err := strconv.ParseUint(text, 10, 16)
	if err != nil || parsed > uint64(maximum) {
		return 0, fmt.Errorf("%s is out of range", name)
	}
	return int(parsed), nil
}

func payloadString(payload map[string]any, name string) (string, error) {
	return controlString(payload[name], "payload "+name)
}

func validateControlUint64(value, name string, positive bool) error {
	parsed, err := confirmationGeneration(value)
	if err != nil {
		return fmt.Errorf("%s must be canonical uint64", name)
	}
	if positive && parsed == 0 {
		return fmt.Errorf("%s must be positive", name)
	}
	return nil
}

func validateControlB64(value string, length int, name string) error {
	decoded, err := DecodeB64(value)
	if err != nil || len(decoded) != length {
		return fmt.Errorf("%s must be canonical base64url for %d bytes", name, length)
	}
	return nil
}

func validatePairControlPayload(value PairControlRecord) error {
	payload := value.Payload
	if payload == nil {
		return fmt.Errorf("payload must be an object")
	}
	switch value.Type {
	case 1:
		if err := exactObject(payload, "resumeConnectionGeneration", "resumeSequence"); err != nil {
			return err
		}
		generation, err := payloadString(payload, "resumeConnectionGeneration")
		if err != nil {
			return err
		}
		sequence, err := payloadString(payload, "resumeSequence")
		if err != nil {
			return err
		}
		if err := validateControlUint64(generation, "resume connection generation", false); err != nil {
			return err
		}
		return validateControlUint64(sequence, "resume sequence", false)
	case 2:
		if err := exactObject(payload, "capabilitiesSha256", "coordinationMinor"); err != nil {
			return err
		}
		hashValue, err := payloadString(payload, "capabilitiesSha256")
		if err != nil {
			return err
		}
		if err := validateControlB64(hashValue, 32, "capabilities hash"); err != nil {
			return err
		}
		_, err = controlInt(payload["coordinationMinor"], "coordination minor", 65535)
		return err
	case 3:
		if err := exactObject(payload, "endpointEpoch", "ciphertext", "ciphertextSha256"); err != nil {
			return err
		}
		epoch, err := payloadString(payload, "endpointEpoch")
		if err != nil {
			return err
		}
		if err := validateControlUint64(epoch, "endpoint epoch", false); err != nil {
			return err
		}
		ciphertext, err := payloadString(payload, "ciphertext")
		if err != nil {
			return err
		}
		decoded, err := DecodeB64(ciphertext)
		if err != nil || len(decoded) < 1 || len(decoded) > 1200 {
			return fmt.Errorf("ciphertext must be canonical base64url for 1 to 1200 bytes")
		}
		hashValue, err := payloadString(payload, "ciphertextSha256")
		if err != nil {
			return err
		}
		return validateControlB64(hashValue, 32, "ciphertext hash")
	case 4:
		if err := exactObject(payload, "endpointEpoch", "ciphertextSha256"); err != nil {
			return err
		}
		epoch, err := payloadString(payload, "endpointEpoch")
		if err != nil {
			return err
		}
		if err := validateControlUint64(epoch, "endpoint epoch", false); err != nil {
			return err
		}
		hashValue, err := payloadString(payload, "ciphertextSha256")
		if err != nil {
			return err
		}
		return validateControlB64(hashValue, 32, "ciphertext hash")
	case 5:
		if err := exactObject(payload, "state", "validUntil"); err != nil {
			return err
		}
		state, err := payloadString(payload, "state")
		if err != nil || (state != "online" && state != "offline") {
			return fmt.Errorf("presence state is invalid")
		}
		validUntil, err := payloadString(payload, "validUntil")
		if err != nil {
			return err
		}
		return validateControlUint64(validUntil, "presence valid until", false)
	case 6:
		if err := exactObject(payload, "lastReceivedConnectionGeneration", "lastReceivedSequence"); err != nil {
			return err
		}
		generation, err := payloadString(payload, "lastReceivedConnectionGeneration")
		if err != nil {
			return err
		}
		sequence, err := payloadString(payload, "lastReceivedSequence")
		if err != nil {
			return err
		}
		if err := validateControlUint64(generation, "last received generation", false); err != nil {
			return err
		}
		return validateControlUint64(sequence, "last received sequence", false)
	case 7:
		if err := exactObject(payload, "revocationEpoch", "reason", "revocationMac"); err != nil {
			return err
		}
		epoch, err := payloadString(payload, "revocationEpoch")
		if err != nil {
			return err
		}
		if err := validateControlUint64(epoch, "revocation epoch", false); err != nil {
			return err
		}
		reason, err := payloadString(payload, "reason")
		if err != nil || (reason != "user_revoked" && reason != "identity_reset" && reason != "repair_required") {
			return fmt.Errorf("revocation reason is invalid")
		}
		mac, err := payloadString(payload, "revocationMac")
		if err != nil {
			return err
		}
		return validateControlB64(mac, 32, "revocation MAC")
	case 8:
		if err := exactObject(payload, "revocationEpoch", "revocationMac"); err != nil {
			return err
		}
		epoch, err := payloadString(payload, "revocationEpoch")
		if err != nil {
			return err
		}
		if err := validateControlUint64(epoch, "revocation epoch", false); err != nil {
			return err
		}
		mac, err := payloadString(payload, "revocationMac")
		if err != nil {
			return err
		}
		return validateControlB64(mac, 32, "revocation MAC")
	case 9:
		if err := exactObject(payload, "code", "forConnectionGeneration", "forSequence"); err != nil {
			return err
		}
		code, err := payloadString(payload, "code")
		if err != nil {
			return err
		}
		validCode := code == "protocol_mismatch" || code == "stale_generation" || code == "sequence_gap" || code == "revoked" || code == "resync_required"
		if !validCode {
			return fmt.Errorf("control error code is invalid")
		}
		generation, err := payloadString(payload, "forConnectionGeneration")
		if err != nil {
			return err
		}
		sequence, err := payloadString(payload, "forSequence")
		if err != nil {
			return err
		}
		if err := validateControlUint64(generation, "error generation", false); err != nil {
			return err
		}
		return validateControlUint64(sequence, "error sequence", false)
	default:
		return fmt.Errorf("control record type is invalid")
	}
}

func ValidatePairControlRecord(value PairControlRecord, requireSignature bool) error {
	if value.Version != 1 || value.ProtocolMajor < 0 || value.ProtocolMajor > 65535 || value.ProtocolMinor < 0 || value.ProtocolMinor > 65535 {
		return fmt.Errorf("record version or protocol is invalid")
	}
	if _, ok := pairControlTypeNames[value.Type]; !ok || (value.Side != 1 && value.Side != 2) {
		return fmt.Errorf("record type or side is invalid")
	}
	if err := validateControlB64(value.PairID, 16, "pair ID"); err != nil {
		return err
	}
	if err := validateControlUint64(value.ConnectionGeneration, "connection generation", true); err != nil {
		return err
	}
	if err := validateControlUint64(value.Sequence, "sequence", true); err != nil {
		return err
	}
	if err := validateControlUint64(value.Timestamp, "timestamp", false); err != nil {
		return err
	}
	if err := validateControlB64(value.Nonce, 16, "record nonce"); err != nil {
		return err
	}
	if requireSignature {
		if err := validateControlB64(value.Signature, 64, "record signature"); err != nil {
			return err
		}
	}
	return validatePairControlPayload(value)
}

func PairControlSignatureInput(value PairControlRecord) ([]byte, error) {
	if err := ValidatePairControlRecord(value, false); err != nil {
		return nil, err
	}
	protocol := make([]byte, 4)
	binary.BigEndian.PutUint16(protocol[0:2], uint16(value.ProtocolMajor))
	binary.BigEndian.PutUint16(protocol[2:4], uint16(value.ProtocolMinor))
	pairID, err := DecodeB64(value.PairID)
	if err != nil {
		return nil, err
	}
	generation, err := confirmationGeneration(value.ConnectionGeneration)
	if err != nil {
		return nil, err
	}
	sequence, err := confirmationGeneration(value.Sequence)
	if err != nil {
		return nil, err
	}
	timestamp, err := confirmationGeneration(value.Timestamp)
	if err != nil {
		return nil, err
	}
	nonce, err := DecodeB64(value.Nonce)
	if err != nil {
		return nil, err
	}
	payload, err := PairControlPayloadJSON(value)
	if err != nil {
		return nil, err
	}
	uint64Bytes := func(value uint64) []byte {
		encoded := make([]byte, 8)
		binary.BigEndian.PutUint64(encoded, value)
		return encoded
	}
	return bytes.Join([][]byte{
		LP([]byte("waifus/pair-control-record/v1")),
		LP(protocol),
		LP(pairID),
		LP([]byte{byte(value.Type)}),
		LP([]byte{byte(value.Side)}),
		LP(uint64Bytes(generation)),
		LP(uint64Bytes(sequence)),
		LP(uint64Bytes(timestamp)),
		LP(nonce),
		LP(Hash(payload)),
	}, nil), nil
}

func ValidatePairControlPayloadHash(value PairControlRecord) error {
	if value.Type != 3 {
		return nil
	}
	ciphertextValue, err := payloadString(value.Payload, "ciphertext")
	if err != nil {
		return err
	}
	ciphertext, err := DecodeB64(ciphertextValue)
	if err != nil {
		return err
	}
	digest, err := payloadString(value.Payload, "ciphertextSha256")
	if err != nil {
		return err
	}
	decodedDigest, err := DecodeB64(digest)
	if err != nil {
		return controlFailure("invalid_record", err.Error())
	}
	if !hmac.Equal(Hash(ciphertext), decodedDigest) {
		return controlFailure("invalid_payload_hash", "endpoint ciphertext hash differs")
	}
	return nil
}

func SignPairControlRecord(seed []byte, value PairControlRecord, validateHash bool) (PairControlRecord, error) {
	if len(seed) != ed25519.SeedSize {
		return PairControlRecord{}, fmt.Errorf("Ed25519 seed must be 32 bytes")
	}
	value.Signature = ""
	if err := ValidatePairControlRecord(value, false); err != nil {
		return PairControlRecord{}, err
	}
	if validateHash {
		if err := ValidatePairControlPayloadHash(value); err != nil {
			return PairControlRecord{}, err
		}
	}
	input, err := PairControlSignatureInput(value)
	if err != nil {
		return PairControlRecord{}, err
	}
	value.Signature = B64(ed25519.Sign(ed25519.NewKeyFromSeed(seed), input))
	if validateHash {
		encoded, err := CanonicalPairControlJSON(value)
		if err != nil {
			return PairControlRecord{}, err
		}
		if len(encoded) > PairControlRecordMax {
			return PairControlRecord{}, controlFailure("payload_too_large", "signed record exceeds 2048 bytes")
		}
	}
	return value, nil
}

func VerifyPairControlRecord(public []byte, value PairControlRecord) error {
	if len(public) != ed25519.PublicKeySize {
		return fmt.Errorf("installation public key must be 32 bytes")
	}
	if err := ValidatePairControlRecord(value, true); err != nil {
		return controlFailure("invalid_record", err.Error())
	}
	input, err := PairControlSignatureInput(value)
	if err != nil {
		return controlFailure("invalid_record", err.Error())
	}
	signature, err := DecodeB64(value.Signature)
	if err != nil || !ed25519.Verify(public, input, signature) {
		return controlFailure("invalid_signature", "record signature differs")
	}
	return nil
}

func parsePairControlGeneric(payload []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return nil, controlFailure("invalid_canonical_payload", "record is not strict JSON")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, controlFailure("invalid_canonical_payload", "record has trailing JSON")
	}
	object, ok := decoded.(map[string]any)
	if !ok {
		return nil, controlFailure("invalid_record", "record must be an object")
	}
	return object, nil
}

func pairControlRecordFromMap(value map[string]any) (PairControlRecord, error) {
	expected := []string{
		"version", "protocolMajor", "protocolMinor", "pairId", "type", "side",
		"connectionGeneration", "sequence", "timestamp", "nonce", "payload", "signature",
	}
	if err := exactObject(value, expected...); err != nil {
		return PairControlRecord{}, err
	}
	version, err := controlInt(value["version"], "version", 1)
	if err != nil || version != 1 {
		return PairControlRecord{}, fmt.Errorf("version must be 1")
	}
	protocolMajor, err := controlInt(value["protocolMajor"], "protocol major", 65535)
	if err != nil {
		return PairControlRecord{}, err
	}
	protocolMinor, err := controlInt(value["protocolMinor"], "protocol minor", 65535)
	if err != nil {
		return PairControlRecord{}, err
	}
	typeValue, err := controlInt(value["type"], "type", 9)
	if err != nil || typeValue < 1 {
		return PairControlRecord{}, fmt.Errorf("type is invalid")
	}
	side, err := controlInt(value["side"], "side", 2)
	if err != nil || side < 1 {
		return PairControlRecord{}, fmt.Errorf("side is invalid")
	}
	payload, ok := value["payload"].(map[string]any)
	if !ok {
		return PairControlRecord{}, fmt.Errorf("payload must be an object")
	}
	getString := func(name string) (string, error) {
		return controlString(value[name], name)
	}
	pairID, err := getString("pairId")
	if err != nil {
		return PairControlRecord{}, err
	}
	generation, err := getString("connectionGeneration")
	if err != nil {
		return PairControlRecord{}, err
	}
	sequence, err := getString("sequence")
	if err != nil {
		return PairControlRecord{}, err
	}
	timestamp, err := getString("timestamp")
	if err != nil {
		return PairControlRecord{}, err
	}
	nonce, err := getString("nonce")
	if err != nil {
		return PairControlRecord{}, err
	}
	signature, err := getString("signature")
	if err != nil {
		return PairControlRecord{}, err
	}
	result := PairControlRecord{
		Version: version, ProtocolMajor: protocolMajor, ProtocolMinor: protocolMinor,
		PairID: pairID, Type: typeValue, Side: side,
		ConnectionGeneration: generation, Sequence: sequence, Timestamp: timestamp,
		Nonce: nonce, Payload: payload, Signature: signature,
	}
	return result, ValidatePairControlRecord(result, true)
}

func ParseCanonicalPairControlRecord(payload []byte) (PairControlRecord, error) {
	if len(payload) > PairControlRecordMax {
		return PairControlRecord{}, controlFailure("payload_too_large", "record exceeds 2048 bytes")
	}
	generic, err := parsePairControlGeneric(payload)
	if err != nil {
		return PairControlRecord{}, err
	}
	value, err := pairControlRecordFromMap(generic)
	if err != nil {
		return PairControlRecord{}, controlFailure("invalid_record", "PairControlRecordV1 fields are not exact")
	}
	canonical, err := CanonicalPairControlJSON(value)
	if err != nil {
		return PairControlRecord{}, controlFailure("invalid_record", err.Error())
	}
	if !bytes.Equal(canonical, payload) {
		return PairControlRecord{}, controlFailure("invalid_canonical_payload", "record is not canonical JSON")
	}
	if err := ValidatePairControlPayloadHash(value); err != nil {
		return PairControlRecord{}, err
	}
	return value, nil
}

type PairControlTransport string

const (
	ControlWebSocket       PairControlTransport = "websocket"
	ControlHTTPSPublish    PairControlTransport = "https_publish"
	ControlHTTPSRevoke     PairControlTransport = "https_revoke"
	ControlHTTPSRevokeAck  PairControlTransport = "https_revocation_ack"
	ControlHTTPSPoll       PairControlTransport = "https_poll"
	ControlWorkerIngress   string               = "worker_ingress"
	ControlDurableDelivery string               = "durable_delivery"
)

func PairControlTransportAllows(transport PairControlTransport, typeValue int) bool {
	if transport == ControlWebSocket || transport == ControlHTTPSPoll {
		return typeValue >= 1 && typeValue <= 9
	}
	if transport == ControlHTTPSPublish {
		return (typeValue >= 1 && typeValue <= 6) || typeValue == 9
	}
	if transport == ControlHTTPSRevoke {
		return typeValue == 7
	}
	return transport == ControlHTTPSRevokeAck && typeValue == 8
}

type PairRevocationContext struct {
	PairID           string `json:"pairId"`
	HostBundleHash   string `json:"hostBundleHash"`
	RemoteBundleHash string `json:"remoteBundleHash"`
	HostTrustEpoch   string `json:"hostTrustEpoch"`
	RemoteTrustEpoch string `json:"remoteTrustEpoch"`
}

func pairRevocationMACInput(domain string, value PairControlRecord, context PairRevocationContext) ([]byte, error) {
	if value.Type != 7 && value.Type != 8 {
		return nil, fmt.Errorf("record is not revocation or acknowledgement")
	}
	if err := ValidatePairControlRecord(value, false); err != nil {
		return nil, err
	}
	pairID, err := DecodeB64(value.PairID)
	if err != nil {
		return nil, err
	}
	epochText, err := payloadString(value.Payload, "revocationEpoch")
	if err != nil {
		return nil, err
	}
	epoch, err := confirmationGeneration(epochText)
	if err != nil {
		return nil, err
	}
	uint64Bytes := func(value uint64) []byte {
		encoded := make([]byte, 8)
		binary.BigEndian.PutUint64(encoded, value)
		return encoded
	}
	parts := [][]byte{
		LP([]byte(domain)), LP(pairID), LP([]byte{byte(value.Side)}), LP(uint64Bytes(epoch)),
	}
	if value.Type == 7 {
		reason, err := payloadString(value.Payload, "reason")
		if err != nil {
			return nil, err
		}
		parts = append(parts, LP([]byte(reason)))
	}
	hostHash, err := DecodeB64(context.HostBundleHash)
	if err != nil || len(hostHash) != 32 {
		return nil, fmt.Errorf("host bundle hash is invalid")
	}
	remoteHash, err := DecodeB64(context.RemoteBundleHash)
	if err != nil || len(remoteHash) != 32 || hmac.Equal(hostHash, remoteHash) {
		return nil, fmt.Errorf("remote bundle hash is invalid")
	}
	hostEpoch, err := confirmationGeneration(context.HostTrustEpoch)
	if err != nil {
		return nil, err
	}
	remoteEpoch, err := confirmationGeneration(context.RemoteTrustEpoch)
	if err != nil {
		return nil, err
	}
	nonce, err := DecodeB64(value.Nonce)
	if err != nil {
		return nil, err
	}
	parts = append(parts,
		LP(hostHash), LP(remoteHash), LP(uint64Bytes(hostEpoch)), LP(uint64Bytes(remoteEpoch)), LP(nonce),
	)
	return bytes.Join(parts, nil), nil
}

func PairRevocationMACInput(value PairControlRecord, context PairRevocationContext) ([]byte, error) {
	return pairRevocationMACInput("waifus/pair-revocation/v1", value, context)
}

func PairRevocationAckMACInput(value PairControlRecord, context PairRevocationContext) ([]byte, error) {
	return pairRevocationMACInput("waifus/pair-revocation-ack/v1", value, context)
}

func DerivePairRevocationMAC(key []byte, value PairControlRecord, context PairRevocationContext) ([]byte, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("revocation key must be 32 bytes")
	}
	var input []byte
	var err error
	if value.Type == 7 {
		input, err = PairRevocationMACInput(value, context)
	} else if value.Type == 8 {
		input, err = PairRevocationAckMACInput(value, context)
	} else {
		return nil, fmt.Errorf("record is not revocation or acknowledgement")
	}
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(input)
	return mac.Sum(nil), nil
}

func VerifyPairRevocationMAC(key []byte, value PairControlRecord, context PairRevocationContext) bool {
	if value.Type != 7 && value.Type != 8 || value.PairID != context.PairID {
		return false
	}
	candidateText, err := payloadString(value.Payload, "revocationMac")
	if err != nil {
		return false
	}
	candidate, err := DecodeB64(candidateText)
	if err != nil || len(candidate) != 32 {
		return false
	}
	expected, err := DerivePairRevocationMAC(key, value, context)
	return err == nil && hmac.Equal(candidate, expected)
}

type PairControlVerifyOptions struct {
	InstallationPublicKey []byte
	ExpectedPairID        string
	ExpectedSide          int
	NowSeconds            uint64
	TimestampMode         string
	Transport             PairControlTransport
	ExpectedProtocolMajor int
	ExpectedProtocolMinor int
	RevocationKey         []byte
	RevocationContext     *PairRevocationContext
}

func validatePairControlTimestamp(value PairControlRecord, now uint64, mode string) error {
	timestamp, err := confirmationGeneration(value.Timestamp)
	if err != nil {
		return controlFailure("invalid_record", err.Error())
	}
	if mode == ControlWorkerIngress {
		if (timestamp > now && timestamp-now > PairControlClockSkew) || (now > timestamp && now-timestamp > PairControlClockSkew) {
			return controlFailure("timestamp_out_of_window", "first ingress timestamp is outside 60 seconds")
		}
	} else if mode == ControlDurableDelivery {
		if timestamp > now && timestamp-now > PairControlClockSkew {
			return controlFailure("timestamp_in_future", "durable record timestamp is too far in the future")
		}
	} else {
		return fmt.Errorf("timestamp mode is invalid")
	}
	if value.Type == 5 {
		validUntilText, err := payloadString(value.Payload, "validUntil")
		if err != nil {
			return controlFailure("invalid_record", err.Error())
		}
		validUntil, err := confirmationGeneration(validUntilText)
		if err != nil {
			return controlFailure("invalid_record", err.Error())
		}
		if validUntil < now {
			return controlFailure("presence_expired", "presence validity elapsed")
		}
	}
	return nil
}

func ParseAndVerifyPairControlRecord(payload []byte, options PairControlVerifyOptions) (PairControlRecord, error) {
	value, err := ParseCanonicalPairControlRecord(payload)
	if err != nil {
		return PairControlRecord{}, err
	}
	if !PairControlTransportAllows(options.Transport, value.Type) {
		return PairControlRecord{}, controlFailure("wrong_transport", "record type is forbidden on transport")
	}
	if err := VerifyPairControlRecord(options.InstallationPublicKey, value); err != nil {
		return PairControlRecord{}, err
	}
	if value.ProtocolMajor != options.ExpectedProtocolMajor || value.ProtocolMinor != options.ExpectedProtocolMinor {
		return PairControlRecord{}, controlFailure("protocol_mismatch", "record protocol differs")
	}
	if value.PairID != options.ExpectedPairID {
		return PairControlRecord{}, controlFailure("wrong_pair", "record pair differs")
	}
	if value.Side != options.ExpectedSide {
		return PairControlRecord{}, controlFailure("wrong_side", "record side differs")
	}
	if err := validatePairControlTimestamp(value, options.NowSeconds, options.TimestampMode); err != nil {
		return PairControlRecord{}, err
	}
	if options.RevocationContext != nil && (value.Type == 7 || value.Type == 8) {
		if !VerifyPairRevocationMAC(options.RevocationKey, value, *options.RevocationContext) {
			return PairControlRecord{}, controlFailure("invalid_revocation_mac", "revocation MAC differs")
		}
	}
	return value, nil
}

type PairControlSideState struct {
	ConnectionGeneration string
	Sequence             string
	RecordHash           string
}

type PairControlSnapshot struct {
	Version      int
	Host         *PairControlSideState
	Remote       *PairControlSideState
	HostNonces   []string
	RemoteNonces []string
}

type PairControlIngress struct {
	ExpectedPairID  string
	HostPublicKey   []byte
	RemotePublicKey []byte
	ProtocolMajor   int
	ProtocolMinor   int
	Host            *PairControlSideState
	Remote          *PairControlSideState
	HostNonces      map[string]struct{}
	RemoteNonces    map[string]struct{}
}

func NewPairControlIngress(pairID string, hostPublic, remotePublic []byte, snapshot *PairControlSnapshot) (*PairControlIngress, error) {
	if err := validateControlB64(pairID, 16, "expected pair ID"); err != nil || len(hostPublic) != 32 || len(remotePublic) != 32 {
		return nil, fmt.Errorf("invalid pair-control ingress identity")
	}
	result := &PairControlIngress{
		ExpectedPairID: pairID, HostPublicKey: append([]byte(nil), hostPublic...), RemotePublicKey: append([]byte(nil), remotePublic...),
		ProtocolMajor: 1, ProtocolMinor: 0, HostNonces: map[string]struct{}{}, RemoteNonces: map[string]struct{}{},
	}
	if snapshot == nil {
		return result, nil
	}
	if snapshot.Version != 1 {
		return nil, fmt.Errorf("unsupported pair-control snapshot")
	}
	validateSide := func(value *PairControlSideState) error {
		if value == nil {
			return nil
		}
		if err := validateControlUint64(value.ConnectionGeneration, "snapshot generation", true); err != nil {
			return err
		}
		if err := validateControlUint64(value.Sequence, "snapshot sequence", true); err != nil {
			return err
		}
		return validateControlB64(value.RecordHash, 32, "snapshot record hash")
	}
	if err := validateSide(snapshot.Host); err != nil {
		return nil, err
	}
	if err := validateSide(snapshot.Remote); err != nil {
		return nil, err
	}
	if snapshot.Host != nil {
		host := *snapshot.Host
		result.Host = &host
	}
	if snapshot.Remote != nil {
		remote := *snapshot.Remote
		result.Remote = &remote
	}
	restoreNonces := func(values []string, target map[string]struct{}) error {
		previous := ""
		for _, nonce := range values {
			if err := validateControlB64(nonce, 16, "snapshot nonce"); err != nil || (previous != "" && previous >= nonce) {
				return fmt.Errorf("snapshot nonces must be sorted and unique")
			}
			target[nonce] = struct{}{}
			previous = nonce
		}
		return nil
	}
	if err := restoreNonces(snapshot.HostNonces, result.HostNonces); err != nil {
		return nil, err
	}
	if err := restoreNonces(snapshot.RemoteNonces, result.RemoteNonces); err != nil {
		return nil, err
	}
	if (result.Host == nil && len(result.HostNonces) > 0) || (result.Remote == nil && len(result.RemoteNonces) > 0) {
		return nil, fmt.Errorf("snapshot nonces require side high-water")
	}
	return result, nil
}

func (s *PairControlIngress) Accept(payload []byte, transport PairControlTransport, now uint64) (string, error) {
	if transport == ControlHTTPSPoll {
		return "", controlFailure("wrong_transport", "HTTPS poll is delivery-only")
	}
	candidate, err := ParseCanonicalPairControlRecord(payload)
	if err != nil {
		return "", err
	}
	public := s.HostPublicKey
	if candidate.Side == 2 {
		public = s.RemotePublicKey
	}
	value, err := ParseAndVerifyPairControlRecord(payload, PairControlVerifyOptions{
		InstallationPublicKey: public, ExpectedPairID: s.ExpectedPairID, ExpectedSide: candidate.Side,
		NowSeconds: now, TimestampMode: ControlWorkerIngress, Transport: transport,
		ExpectedProtocolMajor: s.ProtocolMajor, ExpectedProtocolMinor: s.ProtocolMinor,
	})
	if err != nil {
		return "", err
	}
	current := s.Host
	nonces := s.HostNonces
	if value.Side == 2 {
		current = s.Remote
		nonces = s.RemoteNonces
	}
	generation, err := confirmationGeneration(value.ConnectionGeneration)
	if err != nil {
		return "", controlFailure("invalid_record", err.Error())
	}
	sequence, err := confirmationGeneration(value.Sequence)
	if err != nil {
		return "", controlFailure("invalid_record", err.Error())
	}
	recordHash := B64(Hash(payload))
	if current == nil {
		if generation != 1 || sequence != 1 {
			return "", controlFailure("invalid_generation_start", "side must start at generation 1 sequence 1")
		}
	} else {
		currentGeneration, err := confirmationGeneration(current.ConnectionGeneration)
		if err != nil {
			return "", fmt.Errorf("stored connection generation is corrupt: %w", err)
		}
		currentSequence, err := confirmationGeneration(current.Sequence)
		if err != nil {
			return "", fmt.Errorf("stored sequence is corrupt: %w", err)
		}
		if generation < currentGeneration {
			return "", controlFailure("stale_generation", "generation is below high-water")
		}
		if generation == currentGeneration {
			if sequence < currentSequence {
				return "", controlFailure("stale_sequence", "sequence is below high-water")
			}
			if sequence == currentSequence {
				if recordHash == current.RecordHash {
					return "idempotent", nil
				}
				return "", controlFailure("tuple_conflict", "same tuple has different bytes")
			}
		} else if sequence != 1 {
			return "", controlFailure("invalid_generation_start", "higher generation must start at sequence 1")
		}
	}
	if _, exists := nonces[value.Nonce]; exists {
		return "", controlFailure("nonce_reused", "side nonce was already accepted")
	}
	next := &PairControlSideState{ConnectionGeneration: value.ConnectionGeneration, Sequence: value.Sequence, RecordHash: recordHash}
	nonces[value.Nonce] = struct{}{}
	if value.Side == 1 {
		s.Host = next
	} else {
		s.Remote = next
	}
	return "accepted", nil
}

func (s *PairControlIngress) Snapshot() PairControlSnapshot {
	hostNonces := make([]string, 0, len(s.HostNonces))
	for nonce := range s.HostNonces {
		hostNonces = append(hostNonces, nonce)
	}
	remoteNonces := make([]string, 0, len(s.RemoteNonces))
	for nonce := range s.RemoteNonces {
		remoteNonces = append(remoteNonces, nonce)
	}
	sort.Strings(hostNonces)
	sort.Strings(remoteNonces)
	var host *PairControlSideState
	if s.Host != nil {
		copy := *s.Host
		host = &copy
	}
	var remote *PairControlSideState
	if s.Remote != nil {
		copy := *s.Remote
		remote = &copy
	}
	return PairControlSnapshot{
		Version: 1, Host: host, Remote: remote,
		HostNonces: hostNonces, RemoteNonces: remoteNonces,
	}
}
