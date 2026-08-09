package pairing

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
)

const ConfirmationPayloadMax = 1024

type ConfirmationError struct {
	Code   string
	Detail string
}

func (e *ConfirmationError) Error() string {
	return e.Code + ": " + e.Detail
}

func confirmationFailure(code, detail string) error {
	return &ConfirmationError{Code: code, Detail: detail}
}

type PairConfirmation struct {
	Version              int    `json:"version"`
	InvitationID         string `json:"invitationId"`
	InvitationGeneration string `json:"invitationGeneration"`
	PairID               string `json:"pairId"`
	Side                 int    `json:"side"`
	TranscriptHash       string `json:"transcriptHash"`
	ChannelBinding       string `json:"channelBinding"`
	HostBundleHash       string `json:"hostBundleHash"`
	RemoteBundleHash     string `json:"remoteBundleHash"`
	ApprovalContextHash  string `json:"approvalContextHash"`
	ConfirmationNonce    string `json:"confirmationNonce"`
	ConfirmationMAC      string `json:"confirmationMac"`
}

func confirmationBytes(value string, length int, name string) ([]byte, error) {
	decoded, err := DecodeB64(value)
	if err != nil || len(decoded) != length {
		return nil, fmt.Errorf("%s must be canonical base64url for %d bytes", name, length)
	}
	return decoded, nil
}

func confirmationGeneration(value string) (uint64, error) {
	if value == "" || (len(value) > 1 && value[0] == '0') {
		return 0, fmt.Errorf("invitation generation is not canonical uint64")
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || strconv.FormatUint(parsed, 10) != value {
		return 0, fmt.Errorf("invitation generation is not canonical uint64")
	}
	return parsed, nil
}

func ValidatePairConfirmation(value PairConfirmation) error {
	if value.Version != 1 || (value.Side != 1 && value.Side != 2) {
		return fmt.Errorf("unsupported confirmation version or side")
	}
	if _, err := confirmationBytes(value.InvitationID, 16, "invitation ID"); err != nil {
		return err
	}
	if _, err := confirmationGeneration(value.InvitationGeneration); err != nil {
		return err
	}
	if _, err := confirmationBytes(value.PairID, 16, "pair ID"); err != nil {
		return err
	}
	for name, field := range map[string]string{
		"transcript hash":       value.TranscriptHash,
		"channel binding":       value.ChannelBinding,
		"host bundle hash":      value.HostBundleHash,
		"remote bundle hash":    value.RemoteBundleHash,
		"approval context hash": value.ApprovalContextHash,
		"confirmation MAC":      value.ConfirmationMAC,
	} {
		if _, err := confirmationBytes(field, 32, name); err != nil {
			return err
		}
	}
	if value.HostBundleHash == value.RemoteBundleHash {
		return fmt.Errorf("host and remote bundle hashes must differ")
	}
	if _, err := confirmationBytes(value.ConfirmationNonce, 16, "confirmation nonce"); err != nil {
		return err
	}
	return nil
}

func PairConfirmationMACInput(value PairConfirmation) ([]byte, error) {
	if value.ConfirmationMAC == "" {
		value.ConfirmationMAC = B64(make([]byte, 32))
	}
	if err := ValidatePairConfirmation(value); err != nil {
		return nil, err
	}
	invitationID, err := DecodeB64(value.InvitationID)
	if err != nil {
		return nil, err
	}
	generation, err := confirmationGeneration(value.InvitationGeneration)
	if err != nil {
		return nil, err
	}
	generationBytes := make([]byte, 8)
	binary.BigEndian.PutUint64(generationBytes, generation)
	pairID, err := DecodeB64(value.PairID)
	if err != nil {
		return nil, err
	}
	transcriptHash, err := DecodeB64(value.TranscriptHash)
	if err != nil {
		return nil, err
	}
	channelBinding, err := DecodeB64(value.ChannelBinding)
	if err != nil {
		return nil, err
	}
	hostBundleHash, err := DecodeB64(value.HostBundleHash)
	if err != nil {
		return nil, err
	}
	remoteBundleHash, err := DecodeB64(value.RemoteBundleHash)
	if err != nil {
		return nil, err
	}
	approvalContextHash, err := DecodeB64(value.ApprovalContextHash)
	if err != nil {
		return nil, err
	}
	confirmationNonce, err := DecodeB64(value.ConfirmationNonce)
	if err != nil {
		return nil, err
	}
	return bytes.Join([][]byte{
		LP([]byte("waifus/pair-confirmation/v1")),
		LP(invitationID),
		LP(generationBytes),
		LP(pairID),
		LP([]byte{byte(value.Side)}),
		LP(transcriptHash),
		LP(channelBinding),
		LP(hostBundleHash),
		LP(remoteBundleHash),
		LP(approvalContextHash),
		LP(confirmationNonce),
	}, nil), nil
}

func DerivePairConfirmationMAC(key []byte, value PairConfirmation) ([]byte, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("confirmation key must be 32 bytes")
	}
	input, err := PairConfirmationMACInput(value)
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(input)
	return mac.Sum(nil), nil
}

func CreatePairConfirmation(key []byte, value PairConfirmation) (PairConfirmation, error) {
	value.ConfirmationMAC = B64(make([]byte, 32))
	mac, err := DerivePairConfirmationMAC(key, value)
	if err != nil {
		return PairConfirmation{}, err
	}
	value.ConfirmationMAC = B64(mac)
	return value, ValidatePairConfirmation(value)
}

func CanonicalPairConfirmationJSON(value PairConfirmation) ([]byte, error) {
	if err := ValidatePairConfirmation(value); err != nil {
		return nil, err
	}
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

func VerifyPairConfirmation(key []byte, value PairConfirmation) error {
	if err := ValidatePairConfirmation(value); err != nil {
		return confirmationFailure("invalid_record", err.Error())
	}
	candidate, err := DecodeB64(value.ConfirmationMAC)
	if err != nil {
		return confirmationFailure("invalid_record", err.Error())
	}
	expected, err := DerivePairConfirmationMAC(key, value)
	if err != nil {
		return confirmationFailure("invalid_record", err.Error())
	}
	if !hmac.Equal(candidate, expected) {
		return confirmationFailure("invalid_mac", "confirmation MAC differs")
	}
	return nil
}

func ParseAndVerifyPairConfirmation(payload, key []byte) (PairConfirmation, error) {
	if len(payload) > ConfirmationPayloadMax {
		return PairConfirmation{}, confirmationFailure("payload_too_large", "payload exceeds 1024 bytes")
	}
	genericDecoder := json.NewDecoder(bytes.NewReader(payload))
	var generic any
	if err := genericDecoder.Decode(&generic); err != nil {
		return PairConfirmation{}, confirmationFailure("invalid_canonical_payload", "payload is not strict JSON")
	}
	var trailing any
	if err := genericDecoder.Decode(&trailing); err != io.EOF {
		return PairConfirmation{}, confirmationFailure("invalid_canonical_payload", "payload has trailing JSON")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var value PairConfirmation
	if err := decoder.Decode(&value); err != nil {
		return PairConfirmation{}, confirmationFailure("invalid_record", "PairConfirmationV1 fields are not exact")
	}
	if err := ValidatePairConfirmation(value); err != nil {
		return PairConfirmation{}, confirmationFailure("invalid_record", err.Error())
	}
	canonical, err := CanonicalPairConfirmationJSON(value)
	if err != nil {
		return PairConfirmation{}, confirmationFailure("invalid_record", err.Error())
	}
	if !bytes.Equal(canonical, payload) {
		return PairConfirmation{}, confirmationFailure("invalid_canonical_payload", "payload is not canonical JSON")
	}
	if err := VerifyPairConfirmation(key, value); err != nil {
		return PairConfirmation{}, err
	}
	return value, nil
}

type PairConfirmationContext struct {
	InvitationID         string
	InvitationGeneration string
	PairID               string
	TranscriptHash       string
	ChannelBinding       string
	HostBundleHash       string
	RemoteBundleHash     string
	ApprovalContextHash  string
}

type ConfirmationSession struct {
	LocalSide           int
	Key                 []byte
	Context             PairConfirmationContext
	Phase               string
	LocalPayload        []byte
	PeerPayload         []byte
	ConsumeAcknowledged bool
}

func NewConfirmationSession(localSide int, key []byte, context PairConfirmationContext) (*ConfirmationSession, error) {
	if (localSide != 1 && localSide != 2) || len(key) != 32 {
		return nil, fmt.Errorf("invalid local side or confirmation key")
	}
	return &ConfirmationSession{
		LocalSide: localSide,
		Key:       append([]byte(nil), key...),
		Context:   context,
		Phase:     "pre_approval",
	}, nil
}

func (s *ConfirmationSession) Approve() (bool, error) {
	if s.Phase == "approved" {
		return false, nil
	}
	if s.Phase != "pre_approval" {
		return false, confirmationFailure("invalid_phase", "cannot approve from "+s.Phase)
	}
	s.Phase = "approved"
	return true, nil
}

func (s *ConfirmationSession) requireApproved() error {
	if s.Phase != "approved" {
		return confirmationFailure("invalid_phase", "confirmation not allowed in "+s.Phase)
	}
	return nil
}

func (s *ConfirmationSession) requireContext(value PairConfirmation) error {
	if value.InvitationID != s.Context.InvitationID ||
		value.InvitationGeneration != s.Context.InvitationGeneration ||
		value.PairID != s.Context.PairID ||
		value.TranscriptHash != s.Context.TranscriptHash ||
		value.ChannelBinding != s.Context.ChannelBinding ||
		value.HostBundleHash != s.Context.HostBundleHash ||
		value.RemoteBundleHash != s.Context.RemoteBundleHash ||
		value.ApprovalContextHash != s.Context.ApprovalContextHash {
		return confirmationFailure("context_mismatch", "confirmation differs from approved context")
	}
	return nil
}

func (s *ConfirmationSession) PublishLocal(value PairConfirmation) (bool, error) {
	if err := s.requireApproved(); err != nil {
		return false, err
	}
	if err := VerifyPairConfirmation(s.Key, value); err != nil {
		return false, err
	}
	if value.Side != s.LocalSide {
		return false, confirmationFailure("wrong_side", "local record uses peer side")
	}
	if err := s.requireContext(value); err != nil {
		return false, err
	}
	payload, err := CanonicalPairConfirmationJSON(value)
	if err != nil {
		return false, confirmationFailure("invalid_record", err.Error())
	}
	if s.LocalPayload != nil {
		if bytes.Equal(s.LocalPayload, payload) {
			return false, nil
		}
		return false, confirmationFailure("duplicate_confirmation", "different local confirmation already stored")
	}
	s.LocalPayload = payload
	return true, nil
}

func (s *ConfirmationSession) ReceivePeer(recordType string, payload []byte) (bool, error) {
	if err := s.requireApproved(); err != nil {
		return false, err
	}
	if s.LocalPayload == nil {
		return false, confirmationFailure("local_not_published", "local confirmation must publish first")
	}
	if recordType != "pair_confirmation" {
		return false, confirmationFailure("wrong_record_type", "confirmation cannot use Noise transport")
	}
	value, err := ParseAndVerifyPairConfirmation(payload, s.Key)
	if err != nil {
		return false, err
	}
	peerSide := 1
	if s.LocalSide == 1 {
		peerSide = 2
	}
	if value.Side != peerSide {
		return false, confirmationFailure("wrong_side", "peer record uses local side")
	}
	if err := s.requireContext(value); err != nil {
		return false, err
	}
	if s.PeerPayload != nil {
		if bytes.Equal(s.PeerPayload, payload) {
			return false, nil
		}
		return false, confirmationFailure("duplicate_confirmation", "different peer confirmation already stored")
	}
	s.PeerPayload = append([]byte(nil), payload...)
	return true, nil
}

func (s *ConfirmationSession) Consume() (bool, error) {
	if s.Phase == "consumed" {
		return false, nil
	}
	if err := s.requireApproved(); err != nil {
		return false, err
	}
	if s.PeerPayload == nil {
		return false, confirmationFailure("peer_not_verified", "peer confirmation must verify before consume")
	}
	s.ConsumeAcknowledged = true
	s.Phase = "consumed"
	return true, nil
}

func (s *ConfirmationSession) Cancel() error {
	if s.Phase == "cancelled" {
		return nil
	}
	if s.Phase == "consumed" || s.Phase == "expired" {
		return confirmationFailure("invalid_phase", "cannot cancel from "+s.Phase)
	}
	s.Phase = "cancelled"
	return nil
}

func (s *ConfirmationSession) Expire() error {
	if s.Phase == "expired" {
		return nil
	}
	if s.Phase == "consumed" || s.Phase == "cancelled" {
		return confirmationFailure("invalid_phase", "cannot expire from "+s.Phase)
	}
	s.Phase = "expired"
	return nil
}
