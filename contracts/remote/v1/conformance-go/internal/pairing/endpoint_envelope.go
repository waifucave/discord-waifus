package pairing

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"sort"

	"golang.org/x/crypto/chacha20poly1305"
)

const (
	EndpointPlaintextMax  = 1184
	EndpointCiphertextMax = 1200
	EndpointCandidateMax  = 12
)

type EndpointError struct {
	Code   string
	Detail string
}

func (e *EndpointError) Error() string {
	return e.Code + ": " + e.Detail
}

func endpointFailure(code, detail string) error {
	return &EndpointError{Code: code, Detail: detail}
}

type EndpointCandidate struct {
	Kind     uint8
	Family   uint8
	Address  []byte
	Port     uint16
	Priority uint32
}

type EndpointGeneration struct {
	Version              uint8
	EndpointEpoch        uint64
	ConnectionGeneration uint64
	Candidates           []EndpointCandidate
}

type EndpointContext struct {
	NegotiatedMinor              uint16
	PairID                       []byte
	SenderRole                   uint8
	ReceiverRole                 uint8
	HostInstallationBundleHash   []byte
	RemoteInstallationBundleHash []byte
	HostTrustEpoch               uint64
	RemoteTrustEpoch             uint64
	EndpointEpoch                uint64
}

type EndpointDirectionKeys struct {
	HostToRemote []byte
	RemoteToHost []byte
}

func endpointUnsafeAddress(family uint8, address []byte) bool {
	all := func(value byte) bool {
		for _, candidate := range address {
			if candidate != value {
				return false
			}
		}
		return true
	}
	if family == 4 {
		return all(0) || address[0] == 127 || address[0] == 169 && address[1] == 254 ||
			address[0] >= 224 && address[0] <= 239 || all(255)
	}
	loopback := true
	for _, value := range address[:15] {
		if value != 0 {
			loopback = false
			break
		}
	}
	loopback = loopback && address[15] == 1
	mapped := true
	for _, value := range address[:10] {
		if value != 0 {
			mapped = false
			break
		}
	}
	mapped = mapped && address[10] == 0xff && address[11] == 0xff
	return all(0) || loopback || address[0] == 0xfe && address[1]&0xc0 == 0x80 || address[0] == 0xff || mapped
}

func endpointCandidateIdentity(value EndpointCandidate) string {
	return fmt.Sprintf("%d:%d:%x:%d", value.Kind, value.Family, value.Address, value.Port)
}

func endpointCandidateCompare(left, right EndpointCandidate) int {
	if left.Priority != right.Priority {
		if left.Priority > right.Priority {
			return -1
		}
		return 1
	}
	if left.Kind != right.Kind {
		return int(left.Kind) - int(right.Kind)
	}
	if left.Family != right.Family {
		return int(left.Family) - int(right.Family)
	}
	if compared := bytes.Compare(left.Address, right.Address); compared != 0 {
		return compared
	}
	return int(left.Port) - int(right.Port)
}

func cloneEndpointCandidate(value EndpointCandidate) EndpointCandidate {
	value.Address = append([]byte(nil), value.Address...)
	return value
}

func cloneEndpointGeneration(value EndpointGeneration) EndpointGeneration {
	result := value
	result.Candidates = make([]EndpointCandidate, len(value.Candidates))
	for index, candidate := range value.Candidates {
		result.Candidates[index] = cloneEndpointCandidate(candidate)
	}
	return result
}

func validateEndpointGeneration(value EndpointGeneration) (EndpointGeneration, error) {
	if value.Version != 1 || value.EndpointEpoch == 0 || value.ConnectionGeneration == 0 {
		return EndpointGeneration{}, endpointFailure("invalid_endpoint_record", "endpoint version, epoch, or connection generation is invalid")
	}
	if len(value.Candidates) > EndpointCandidateMax {
		return EndpointGeneration{}, endpointFailure("invalid_endpoint_record", "endpoint record contains more than 12 candidates")
	}
	result := cloneEndpointGeneration(value)
	seen := make(map[string]struct{}, len(result.Candidates))
	for index, candidate := range result.Candidates {
		if candidate.Kind < 1 || candidate.Kind > 3 || candidate.Family != 4 && candidate.Family != 6 {
			return EndpointGeneration{}, endpointFailure("invalid_endpoint_record", fmt.Sprintf("candidate %d has an unknown kind or family", index))
		}
		expected := 4
		if candidate.Family == 6 {
			expected = 16
		}
		if len(candidate.Address) != expected || candidate.Port == 0 {
			return EndpointGeneration{}, endpointFailure("invalid_endpoint_record", fmt.Sprintf("candidate %d address or port is invalid", index))
		}
		if endpointUnsafeAddress(candidate.Family, candidate.Address) {
			return EndpointGeneration{}, endpointFailure("unsafe_candidate", fmt.Sprintf("candidate %d is not a probe-safe unicast address", index))
		}
		identity := endpointCandidateIdentity(candidate)
		if _, exists := seen[identity]; exists {
			return EndpointGeneration{}, endpointFailure("duplicate_candidate", fmt.Sprintf("candidate %d duplicates an earlier endpoint", index))
		}
		seen[identity] = struct{}{}
		if index > 0 && endpointCandidateCompare(result.Candidates[index-1], candidate) > 0 {
			return EndpointGeneration{}, endpointFailure("candidates_unsorted", "endpoint candidates are not in deterministic order")
		}
	}
	return result, nil
}

func endpointCandidateMap(value EndpointCandidate) map[uint64]any {
	return map[uint64]any{
		1: uint64(value.Kind),
		2: uint64(value.Family),
		3: value.Address,
		4: uint64(value.Port),
		5: uint64(value.Priority),
	}
}

func EncodeEndpointPlaintext(value EndpointGeneration) ([]byte, error) {
	parsed, err := validateEndpointGeneration(value)
	if err != nil {
		return nil, err
	}
	candidates := make([]any, len(parsed.Candidates))
	for index, candidate := range parsed.Candidates {
		candidates[index] = endpointCandidateMap(candidate)
	}
	encoded, err := EncodeCanonicalCBOR(map[uint64]any{
		1: uint64(1),
		2: parsed.EndpointEpoch,
		3: parsed.ConnectionGeneration,
		4: candidates,
	})
	if err != nil {
		return nil, err
	}
	if len(encoded) > EndpointPlaintextMax {
		return nil, endpointFailure("plaintext_too_large", "canonical endpoint plaintext exceeds 1184 bytes")
	}
	return encoded, nil
}

func endpointExactMap(value any, keys []uint64, name string) (map[uint64]any, error) {
	result, ok := value.(map[uint64]any)
	if !ok || len(result) != len(keys) {
		return nil, endpointFailure("invalid_endpoint_record", name+" must be an exact canonical CBOR map")
	}
	for _, key := range keys {
		if _, ok := result[key]; !ok {
			return nil, endpointFailure("invalid_endpoint_record", fmt.Sprintf("%s is missing integer key %d", name, key))
		}
	}
	return result, nil
}

func endpointUint(value any, name string) (uint64, error) {
	result, ok := value.(uint64)
	if !ok {
		return 0, endpointFailure("invalid_endpoint_record", name+" must be a CBOR unsigned integer")
	}
	return result, nil
}

func DecodeEndpointPlaintext(payload []byte) (EndpointGeneration, error) {
	if len(payload) > EndpointPlaintextMax {
		return EndpointGeneration{}, endpointFailure("plaintext_too_large", "endpoint plaintext exceeds 1184 bytes")
	}
	decoded, err := DecodeCanonicalCBOR(payload)
	if err != nil {
		return EndpointGeneration{}, endpointFailure("invalid_canonical_cbor", "endpoint plaintext is not deterministic RFC 8949 CBOR")
	}
	value, err := endpointExactMap(decoded, []uint64{1, 2, 3, 4}, "endpoint record")
	if err != nil {
		return EndpointGeneration{}, err
	}
	version, err := endpointUint(value[1], "endpoint version")
	if err != nil || version != 1 {
		return EndpointGeneration{}, endpointFailure("invalid_endpoint_record", "endpoint version must be 1")
	}
	epoch, err := endpointUint(value[2], "endpoint epoch")
	if err != nil {
		return EndpointGeneration{}, err
	}
	generation, err := endpointUint(value[3], "connection generation")
	if err != nil {
		return EndpointGeneration{}, err
	}
	candidateValues, ok := value[4].([]any)
	if !ok {
		return EndpointGeneration{}, endpointFailure("invalid_endpoint_record", "endpoint candidates must be a CBOR array")
	}
	candidates := make([]EndpointCandidate, len(candidateValues))
	for index, candidateValue := range candidateValues {
		candidate, err := endpointExactMap(candidateValue, []uint64{1, 2, 3, 4, 5}, fmt.Sprintf("candidate %d", index))
		if err != nil {
			return EndpointGeneration{}, err
		}
		kind, err := endpointUint(candidate[1], "candidate kind")
		if err != nil || kind > 255 {
			return EndpointGeneration{}, endpointFailure("invalid_endpoint_record", "candidate kind exceeds uint8")
		}
		family, err := endpointUint(candidate[2], "candidate family")
		if err != nil || family > 255 {
			return EndpointGeneration{}, endpointFailure("invalid_endpoint_record", "candidate family exceeds uint8")
		}
		address, ok := candidate[3].([]byte)
		if !ok {
			return EndpointGeneration{}, endpointFailure("invalid_endpoint_record", "candidate address must be CBOR bytes")
		}
		port, err := endpointUint(candidate[4], "candidate port")
		if err != nil || port > 65535 {
			return EndpointGeneration{}, endpointFailure("invalid_endpoint_record", "candidate port exceeds uint16")
		}
		priority, err := endpointUint(candidate[5], "candidate priority")
		if err != nil || priority > 0xffffffff {
			return EndpointGeneration{}, endpointFailure("invalid_endpoint_record", "candidate priority exceeds uint32")
		}
		candidates[index] = EndpointCandidate{
			Kind: uint8(kind), Family: uint8(family), Address: address,
			Port: uint16(port), Priority: uint32(priority),
		}
	}
	return validateEndpointGeneration(EndpointGeneration{
		Version: 1, EndpointEpoch: epoch, ConnectionGeneration: generation, Candidates: candidates,
	})
}

func validateEndpointContext(value EndpointContext) (EndpointContext, error) {
	if len(value.PairID) != 16 || len(value.HostInstallationBundleHash) != 32 || len(value.RemoteInstallationBundleHash) != 32 {
		return EndpointContext{}, endpointFailure("invalid_context", "endpoint context has a wrong-width pair or bundle field")
	}
	if value.SenderRole < 1 || value.SenderRole > 2 || value.ReceiverRole < 1 || value.ReceiverRole > 2 || value.SenderRole == value.ReceiverRole {
		return EndpointContext{}, endpointFailure("invalid_context", "sender and receiver must be distinct host/remote roles")
	}
	if hmac.Equal(value.HostInstallationBundleHash, value.RemoteInstallationBundleHash) || value.EndpointEpoch == 0 {
		return EndpointContext{}, endpointFailure("invalid_context", "bundle hashes must differ and endpoint epoch must be positive")
	}
	value.PairID = append([]byte(nil), value.PairID...)
	value.HostInstallationBundleHash = append([]byte(nil), value.HostInstallationBundleHash...)
	value.RemoteInstallationBundleHash = append([]byte(nil), value.RemoteInstallationBundleHash...)
	return value, nil
}

func EncodeEndpointAssociatedData(value EndpointContext) ([]byte, error) {
	context, err := validateEndpointContext(value)
	if err != nil {
		return nil, err
	}
	protocol := make([]byte, 4)
	binary.BigEndian.PutUint16(protocol[:2], 1)
	binary.BigEndian.PutUint16(protocol[2:], context.NegotiatedMinor)
	return bytes.Join([][]byte{
		LP([]byte("waifus-endpoint-envelope/v1")),
		LP(protocol),
		LP(context.PairID),
		LP([]byte{context.SenderRole}),
		LP([]byte{context.ReceiverRole}),
		LP(context.HostInstallationBundleHash),
		LP(context.RemoteInstallationBundleHash),
		LP(uint64Bytes(context.HostTrustEpoch)),
		LP(uint64Bytes(context.RemoteTrustEpoch)),
		LP(uint64Bytes(context.EndpointEpoch)),
	}, nil), nil
}

type endpointADDecoder struct {
	value  []byte
	offset int
}

func (d *endpointADDecoder) read(length int) ([]byte, error) {
	if length < 0 || d.offset+length > len(d.value) {
		return nil, endpointFailure("invalid_context", "endpoint associated data is truncated")
	}
	result := d.value[d.offset : d.offset+length]
	d.offset += length
	return result, nil
}

func (d *endpointADDecoder) lp(expected int, name string) ([]byte, error) {
	lengthBytes, err := d.read(4)
	if err != nil {
		return nil, err
	}
	if int(binary.BigEndian.Uint32(lengthBytes)) != expected {
		return nil, endpointFailure("invalid_context", name+" has the wrong associated-data width")
	}
	return d.read(expected)
}

func DecodeEndpointAssociatedData(payload []byte, expectedMinor *uint16) (EndpointContext, error) {
	d := &endpointADDecoder{value: append([]byte(nil), payload...)}
	domain, err := d.lp(len("waifus-endpoint-envelope/v1"), "domain")
	if err != nil || string(domain) != "waifus-endpoint-envelope/v1" {
		return EndpointContext{}, endpointFailure("invalid_context", "endpoint associated-data domain is wrong")
	}
	protocol, err := d.lp(4, "protocol")
	if err != nil || binary.BigEndian.Uint16(protocol[:2]) != 1 {
		return EndpointContext{}, endpointFailure("invalid_context", "endpoint protocol major is unsupported")
	}
	minor := binary.BigEndian.Uint16(protocol[2:])
	if expectedMinor != nil && minor != *expectedMinor {
		return EndpointContext{}, endpointFailure("invalid_context", "endpoint protocol minor was not negotiated")
	}
	read := func(length int, name string) ([]byte, error) {
		value, readErr := d.lp(length, name)
		return append([]byte(nil), value...), readErr
	}
	context := EndpointContext{NegotiatedMinor: minor}
	if context.PairID, err = read(16, "pair ID"); err != nil {
		return EndpointContext{}, err
	}
	sender, err := read(1, "sender role")
	if err != nil {
		return EndpointContext{}, err
	}
	context.SenderRole = sender[0]
	receiver, err := read(1, "receiver role")
	if err != nil {
		return EndpointContext{}, err
	}
	context.ReceiverRole = receiver[0]
	if context.HostInstallationBundleHash, err = read(32, "host bundle hash"); err != nil {
		return EndpointContext{}, err
	}
	if context.RemoteInstallationBundleHash, err = read(32, "remote bundle hash"); err != nil {
		return EndpointContext{}, err
	}
	hostEpoch, err := read(8, "host trust epoch")
	if err != nil {
		return EndpointContext{}, err
	}
	context.HostTrustEpoch = binary.BigEndian.Uint64(hostEpoch)
	remoteEpoch, err := read(8, "remote trust epoch")
	if err != nil {
		return EndpointContext{}, err
	}
	context.RemoteTrustEpoch = binary.BigEndian.Uint64(remoteEpoch)
	endpointEpoch, err := read(8, "endpoint epoch")
	if err != nil {
		return EndpointContext{}, err
	}
	context.EndpointEpoch = binary.BigEndian.Uint64(endpointEpoch)
	if d.offset != len(d.value) {
		return EndpointContext{}, endpointFailure("invalid_context", "endpoint associated data contains trailing bytes")
	}
	return validateEndpointContext(context)
}

func EndpointNonce(epoch uint64) ([]byte, error) {
	if epoch == 0 {
		return nil, fmt.Errorf("endpoint epoch must be positive")
	}
	return append(make([]byte, 4), uint64Bytes(epoch)...), nil
}

func EncryptEndpointAEAD(key, nonce, associatedData, plaintext []byte) ([]byte, error) {
	if len(key) != chacha20poly1305.KeySize || len(nonce) != chacha20poly1305.NonceSize {
		return nil, fmt.Errorf("endpoint key or nonce has wrong width")
	}
	if len(plaintext) > EndpointPlaintextMax {
		return nil, endpointFailure("plaintext_too_large", "endpoint AEAD plaintext exceeds 1184 bytes")
	}
	aead, err := chacha20poly1305.New(key)
	if err != nil {
		return nil, err
	}
	result := aead.Seal(nil, nonce, plaintext, associatedData)
	if len(result) > EndpointCiphertextMax {
		return nil, endpointFailure("ciphertext_too_large", "endpoint AEAD ciphertext exceeds 1200 bytes")
	}
	return result, nil
}

func DecryptEndpointAEAD(key, nonce, associatedData, ciphertext []byte) ([]byte, error) {
	if len(key) != chacha20poly1305.KeySize || len(nonce) != chacha20poly1305.NonceSize {
		return nil, fmt.Errorf("endpoint key or nonce has wrong width")
	}
	if len(ciphertext) > EndpointCiphertextMax {
		return nil, endpointFailure("ciphertext_too_large", "endpoint AEAD ciphertext exceeds 1200 bytes")
	}
	if len(ciphertext) < 16 {
		return nil, endpointFailure("aead_authentication_failed", "endpoint ciphertext is shorter than its authentication tag")
	}
	aead, err := chacha20poly1305.New(key)
	if err != nil {
		return nil, err
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, associatedData)
	if err != nil {
		return nil, endpointFailure("aead_authentication_failed", "endpoint ciphertext authentication failed")
	}
	return plaintext, nil
}

func endpointDirectionKey(keys EndpointDirectionKeys, sender uint8) ([]byte, error) {
	key := keys.HostToRemote
	if sender == 2 {
		key = keys.RemoteToHost
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("endpoint direction key must be 32 bytes")
	}
	return append([]byte(nil), key...), nil
}

type EncryptedEndpoint struct {
	Plaintext      []byte
	Nonce          []byte
	AssociatedData []byte
	Ciphertext     []byte
}

func EncryptEndpointEnvelope(keys EndpointDirectionKeys, context EndpointContext, value EndpointGeneration, approved bool) (*EncryptedEndpoint, error) {
	if !approved {
		return nil, endpointFailure("unapproved_sender", "endpoint exchange is forbidden before exact approval")
	}
	validatedContext, err := validateEndpointContext(context)
	if err != nil {
		return nil, err
	}
	validatedValue, err := validateEndpointGeneration(value)
	if err != nil {
		return nil, err
	}
	if validatedValue.EndpointEpoch != validatedContext.EndpointEpoch {
		return nil, endpointFailure("epoch_mismatch", "endpoint plaintext epoch does not match nonce/associated data")
	}
	plaintext, err := EncodeEndpointPlaintext(validatedValue)
	if err != nil {
		return nil, err
	}
	nonce, err := EndpointNonce(validatedContext.EndpointEpoch)
	if err != nil {
		return nil, err
	}
	associatedData, err := EncodeEndpointAssociatedData(validatedContext)
	if err != nil {
		return nil, err
	}
	key, err := endpointDirectionKey(keys, validatedContext.SenderRole)
	if err != nil {
		return nil, err
	}
	ciphertext, err := EncryptEndpointAEAD(key, nonce, associatedData, plaintext)
	if err != nil {
		return nil, err
	}
	return &EncryptedEndpoint{Plaintext: plaintext, Nonce: nonce, AssociatedData: associatedData, Ciphertext: ciphertext}, nil
}

func DecryptEndpointEnvelope(keys EndpointDirectionKeys, context EndpointContext, ciphertext []byte, approved bool) (EndpointGeneration, error) {
	if !approved {
		return EndpointGeneration{}, endpointFailure("unapproved_sender", "endpoint exchange is forbidden before exact approval")
	}
	validatedContext, err := validateEndpointContext(context)
	if err != nil {
		return EndpointGeneration{}, err
	}
	key, err := endpointDirectionKey(keys, validatedContext.SenderRole)
	if err != nil {
		return EndpointGeneration{}, err
	}
	nonce, err := EndpointNonce(validatedContext.EndpointEpoch)
	if err != nil {
		return EndpointGeneration{}, err
	}
	associatedData, err := EncodeEndpointAssociatedData(validatedContext)
	if err != nil {
		return EndpointGeneration{}, err
	}
	plaintext, err := DecryptEndpointAEAD(key, nonce, associatedData, ciphertext)
	if err != nil {
		return EndpointGeneration{}, err
	}
	value, err := DecodeEndpointPlaintext(plaintext)
	if err != nil {
		return EndpointGeneration{}, err
	}
	if value.EndpointEpoch != validatedContext.EndpointEpoch {
		return EndpointGeneration{}, endpointFailure("epoch_mismatch", "endpoint plaintext epoch does not match nonce/associated data")
	}
	return value, nil
}

type EndpointReceiveSnapshot struct {
	Version          uint8
	Phase            string
	EndpointEpoch    uint64
	CiphertextSHA256 []byte
	Ciphertext       []byte
	Value            *EndpointGeneration
}

type EndpointReceiveState struct {
	current EndpointReceiveSnapshot
}

func cloneEndpointSnapshot(value EndpointReceiveSnapshot) EndpointReceiveSnapshot {
	result := value
	result.CiphertextSHA256 = append([]byte(nil), value.CiphertextSHA256...)
	result.Ciphertext = append([]byte(nil), value.Ciphertext...)
	if value.Value != nil {
		copy := cloneEndpointGeneration(*value.Value)
		result.Value = &copy
	}
	return result
}

func validateEndpointSnapshot(value EndpointReceiveSnapshot) (EndpointReceiveSnapshot, error) {
	if value.Version != 1 || value.Phase != "empty" && value.Phase != "prepared" && value.Phase != "applied" {
		return EndpointReceiveSnapshot{}, fmt.Errorf("endpoint receive snapshot is not V1")
	}
	if value.Phase == "empty" {
		if value.EndpointEpoch != 0 || len(value.CiphertextSHA256) != 0 || len(value.Ciphertext) != 0 || value.Value != nil {
			return EndpointReceiveSnapshot{}, fmt.Errorf("empty endpoint snapshot contains receive state")
		}
		return cloneEndpointSnapshot(value), nil
	}
	if value.EndpointEpoch == 0 || len(value.CiphertextSHA256) != 32 || len(value.Ciphertext) > EndpointCiphertextMax || value.Value == nil {
		return EndpointReceiveSnapshot{}, fmt.Errorf("prepared/applied endpoint snapshot is incomplete")
	}
	parsed, err := validateEndpointGeneration(*value.Value)
	if err != nil || parsed.EndpointEpoch != value.EndpointEpoch {
		return EndpointReceiveSnapshot{}, fmt.Errorf("endpoint snapshot value is invalid")
	}
	hash := sha256.Sum256(value.Ciphertext)
	if !hmac.Equal(hash[:], value.CiphertextSHA256) {
		return EndpointReceiveSnapshot{}, fmt.Errorf("endpoint snapshot ciphertext hash differs")
	}
	value.Value = &parsed
	return cloneEndpointSnapshot(value), nil
}

func NewEndpointReceiveState(snapshot ...EndpointReceiveSnapshot) (*EndpointReceiveState, error) {
	value := EndpointReceiveSnapshot{Version: 1, Phase: "empty"}
	if len(snapshot) > 0 {
		value = snapshot[0]
	}
	parsed, err := validateEndpointSnapshot(value)
	if err != nil {
		return nil, err
	}
	return &EndpointReceiveState{current: parsed}, nil
}

func (s *EndpointReceiveState) Snapshot() EndpointReceiveSnapshot {
	return cloneEndpointSnapshot(s.current)
}

type EndpointPrepareResult struct {
	Status           string
	Value            EndpointGeneration
	CiphertextSHA256 []byte
}

func (s *EndpointReceiveState) Prepare(keys EndpointDirectionKeys, context EndpointContext, ciphertext []byte, approved bool) (*EndpointPrepareResult, error) {
	if !approved {
		return nil, endpointFailure("unapproved_sender", "endpoint exchange is forbidden before exact approval")
	}
	validatedContext, err := validateEndpointContext(context)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(ciphertext)
	if s.current.Phase == "empty" {
		if validatedContext.EndpointEpoch != 1 {
			return nil, endpointFailure("invalid_initial_epoch", "first received endpoint epoch must be 1")
		}
	} else {
		if validatedContext.EndpointEpoch < s.current.EndpointEpoch {
			return nil, endpointFailure("epoch_rollback", "endpoint epoch is below durable receive high-water")
		}
		if validatedContext.EndpointEpoch == s.current.EndpointEpoch {
			if !hmac.Equal(hash[:], s.current.CiphertextSHA256) {
				return nil, endpointFailure("epoch_conflict", "same endpoint epoch carries different ciphertext bytes")
			}
			if _, err := DecryptEndpointEnvelope(keys, validatedContext, ciphertext, approved); err != nil {
				return nil, err
			}
			status := "already_applied"
			if s.current.Phase == "prepared" {
				status = "resume_prepared"
			}
			return &EndpointPrepareResult{Status: status, Value: cloneEndpointGeneration(*s.current.Value), CiphertextSHA256: append([]byte(nil), hash[:]...)}, nil
		}
	}
	value, err := DecryptEndpointEnvelope(keys, validatedContext, ciphertext, approved)
	if err != nil {
		return nil, err
	}
	s.current, err = validateEndpointSnapshot(EndpointReceiveSnapshot{
		Version: 1, Phase: "prepared", EndpointEpoch: validatedContext.EndpointEpoch,
		CiphertextSHA256: append([]byte(nil), hash[:]...), Ciphertext: append([]byte(nil), ciphertext...), Value: &value,
	})
	if err != nil {
		return nil, err
	}
	return &EndpointPrepareResult{Status: "prepared", Value: cloneEndpointGeneration(value), CiphertextSHA256: append([]byte(nil), hash[:]...)}, nil
}

func (s *EndpointReceiveState) MarkApplied(epoch uint64, ciphertextSHA256 []byte) error {
	if s.current.Phase != "prepared" {
		return endpointFailure("no_prepared_endpoint", "no prepared endpoint record is waiting for application")
	}
	if epoch != s.current.EndpointEpoch || !hmac.Equal(ciphertextSHA256, s.current.CiphertextSHA256) {
		return endpointFailure("epoch_conflict", "applied endpoint receipt does not match prepared record")
	}
	s.current.Phase = "applied"
	return nil
}

func SortEndpointCandidates(values []EndpointCandidate) {
	sort.Slice(values, func(i, j int) bool {
		return endpointCandidateCompare(values[i], values[j]) < 0
	})
}
