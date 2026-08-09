package wipc

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math"
)

const (
	ProtocolMajor            uint16 = 1
	ProtocolMinor            uint16 = 0
	HeaderBytes                     = 24
	ControlPayloadMaxBytes          = 32 * 1024
	EncodedHeadersMaxBytes          = 16 * 1024
	DataPayloadMaxBytes             = 64 * 1024
	AbsolutePayloadMaxBytes         = 65536
	MaxConcurrentStreams            = 128
	InitialStreamCreditBytes        = 1048576
	WindowUpdateBytes               = 8
	authValueBytes                  = 32
)

type FrameType uint8

const (
	FrameHello         FrameType = 0x01
	FrameHelloAck      FrameType = 0x02
	FrameCommand       FrameType = 0x03
	FrameResult        FrameType = 0x04
	FrameEvent         FrameType = 0x05
	FrameRequestStart  FrameType = 0x10
	FrameRequestChunk  FrameType = 0x11
	FrameRequestEnd    FrameType = 0x12
	FrameRequestCancel FrameType = 0x13
	FrameResponseStart FrameType = 0x20
	FrameResponseChunk FrameType = 0x21
	FrameResponseEnd   FrameType = 0x22
	FrameResponseError FrameType = 0x23
	FrameWindowUpdate  FrameType = 0x30
)

type ProtocolError struct {
	Code    string
	Message string
}

func (e *ProtocolError) Error() string {
	return e.Message
}

func protocolError(code string, format string, values ...any) error {
	return &ProtocolError{Code: code, Message: fmt.Sprintf(format, values...)}
}

type Header struct {
	Major         uint16
	Minor         uint16
	FrameType     uint8
	Flags         uint8
	StreamID      uint64
	PayloadLength uint32
}

var magic = [4]byte{'W', 'I', 'P', 'C'}

func knownFrameType(value uint8) bool {
	switch FrameType(value) {
	case FrameHello,
		FrameHelloAck,
		FrameCommand,
		FrameResult,
		FrameEvent,
		FrameRequestStart,
		FrameRequestChunk,
		FrameRequestEnd,
		FrameRequestCancel,
		FrameResponseStart,
		FrameResponseChunk,
		FrameResponseEnd,
		FrameResponseError,
		FrameWindowUpdate:
		return true
	default:
		return false
	}
}

func connectionFrame(frameType FrameType) bool {
	return frameType >= FrameHello && frameType <= FrameEvent
}

func dataFrame(frameType FrameType) bool {
	return frameType == FrameRequestChunk || frameType == FrameResponseChunk
}

func terminalFrame(frameType FrameType) bool {
	return frameType == FrameRequestEnd || frameType == FrameResponseEnd
}

func validateHeader(header Header) error {
	if header.Major != ProtocolMajor || header.Minor != ProtocolMinor {
		return protocolError(
			"unsupported_version",
			"unsupported WIPC version %d.%d; expected %d.%d",
			header.Major,
			header.Minor,
			ProtocolMajor,
			ProtocolMinor,
		)
	}
	if !knownFrameType(header.FrameType) {
		return protocolError("unknown_frame_type", "unknown WIPC frame type 0x%x", header.FrameType)
	}
	if header.Flags != 0 {
		return protocolError("reserved_flags", "all WIPC V1 flag bits are reserved")
	}
	frameType := FrameType(header.FrameType)
	if connectionFrame(frameType) {
		if header.StreamID != 0 {
			return protocolError("invalid_stream_id", "connection-control frames require stream ID zero")
		}
	} else if header.StreamID == 0 {
		return protocolError("invalid_stream_id", "request/response frames require a nonzero stream ID")
	}
	if header.PayloadLength > AbsolutePayloadMaxBytes {
		return protocolError("payload_too_large", "WIPC payload length exceeds the decoder ceiling")
	}
	if dataFrame(frameType) {
		if header.PayloadLength == 0 || header.PayloadLength > DataPayloadMaxBytes {
			return protocolError(
				"invalid_data_payload_length",
				"raw data frames must contain between 1 and 65,536 bytes",
			)
		}
		return nil
	}
	if terminalFrame(frameType) {
		if header.PayloadLength != 0 {
			return protocolError(
				"invalid_terminal_payload_length",
				"REQUEST_END and RESPONSE_END carry no payload",
			)
		}
		return nil
	}
	if frameType == FrameWindowUpdate {
		if header.PayloadLength != WindowUpdateBytes {
			return protocolError(
				"invalid_window_update_length",
				"WINDOW_UPDATE payload must be exactly 8 bytes",
			)
		}
		return nil
	}
	if header.PayloadLength == 0 {
		return protocolError("invalid_control_payload_length", "canonical JSON control payload cannot be empty")
	}
	if header.PayloadLength > ControlPayloadMaxBytes {
		return protocolError("control_payload_too_large", "canonical JSON control payload exceeds 32 KiB")
	}
	return nil
}

func EncodeHeader(header Header) ([]byte, error) {
	if err := validateHeader(header); err != nil {
		return nil, err
	}
	encoded := make([]byte, HeaderBytes)
	copy(encoded[0:4], magic[:])
	binary.BigEndian.PutUint16(encoded[4:6], header.Major)
	binary.BigEndian.PutUint16(encoded[6:8], header.Minor)
	encoded[8] = header.FrameType
	encoded[9] = header.Flags
	binary.BigEndian.PutUint16(encoded[10:12], 0)
	binary.BigEndian.PutUint64(encoded[12:20], header.StreamID)
	binary.BigEndian.PutUint32(encoded[20:24], header.PayloadLength)
	return encoded, nil
}

func DecodeHeader(encoded []byte) (Header, error) {
	if len(encoded) != HeaderBytes {
		return Header{}, protocolError("invalid_header_length", "WIPC header must be exactly 24 bytes")
	}
	if encoded[0] != magic[0] || encoded[1] != magic[1] || encoded[2] != magic[2] || encoded[3] != magic[3] {
		return Header{}, protocolError("invalid_magic", "WIPC header has invalid magic bytes")
	}
	if binary.BigEndian.Uint16(encoded[10:12]) != 0 {
		return Header{}, protocolError("reserved_bytes", "WIPC reserved header bytes must be zero")
	}
	header := Header{
		Major:         binary.BigEndian.Uint16(encoded[4:6]),
		Minor:         binary.BigEndian.Uint16(encoded[6:8]),
		FrameType:     encoded[8],
		Flags:         encoded[9],
		StreamID:      binary.BigEndian.Uint64(encoded[12:20]),
		PayloadLength: binary.BigEndian.Uint32(encoded[20:24]),
	}
	if err := validateHeader(header); err != nil {
		return Header{}, err
	}
	return header, nil
}

type Direction uint8

const (
	DirectionRequest  Direction = 1
	DirectionResponse Direction = 2
)

func (direction Direction) String() string {
	switch direction {
	case DirectionRequest:
		return "request"
	case DirectionResponse:
		return "response"
	default:
		return "unknown"
	}
}

type WindowUpdate struct {
	Direction       Direction
	CreditIncrement uint32
}

func validateWindowUpdate(update WindowUpdate) error {
	if update.Direction != DirectionRequest && update.Direction != DirectionResponse {
		return protocolError("invalid_window_direction", "WINDOW_UPDATE direction must be request or response")
	}
	if update.CreditIncrement == 0 || update.CreditIncrement > InitialStreamCreditBytes {
		return protocolError(
			"invalid_credit_increment",
			"WINDOW_UPDATE credit increment must be between 1 and 1,048,576 bytes",
		)
	}
	return nil
}

func EncodeWindowUpdate(update WindowUpdate) ([]byte, error) {
	if err := validateWindowUpdate(update); err != nil {
		return nil, err
	}
	encoded := make([]byte, WindowUpdateBytes)
	encoded[0] = byte(update.Direction)
	binary.BigEndian.PutUint32(encoded[4:8], update.CreditIncrement)
	return encoded, nil
}

func DecodeWindowUpdate(encoded []byte) (WindowUpdate, error) {
	if len(encoded) != WindowUpdateBytes {
		return WindowUpdate{}, protocolError(
			"invalid_window_update_length",
			"WINDOW_UPDATE payload must be exactly 8 bytes",
		)
	}
	direction := Direction(encoded[0])
	if direction != DirectionRequest && direction != DirectionResponse {
		return WindowUpdate{}, protocolError(
			"invalid_window_direction",
			"WINDOW_UPDATE direction byte must be 1 or 2",
		)
	}
	if encoded[1] != 0 || encoded[2] != 0 || encoded[3] != 0 {
		return WindowUpdate{}, protocolError("reserved_bytes", "WINDOW_UPDATE reserved bytes must be zero")
	}
	update := WindowUpdate{
		Direction:       direction,
		CreditIncrement: binary.BigEndian.Uint32(encoded[4:8]),
	}
	if err := validateWindowUpdate(update); err != nil {
		return WindowUpdate{}, err
	}
	return update, nil
}

type Creator string

const (
	CreatorNode   Creator = "node"
	CreatorHelper Creator = "helper"
)

func expectedParity(creator Creator) (uint64, error) {
	switch creator {
	case CreatorNode:
		return 1, nil
	case CreatorHelper:
		return 0, nil
	default:
		return 0, protocolError("stream_id_parity", "unknown stream creator %q", creator)
	}
}

func validateCreatorStreamID(creator Creator, streamID uint64) error {
	if streamID == 0 {
		return protocolError("invalid_stream_id", "stream ID zero is reserved for connection control")
	}
	parity, err := expectedParity(creator)
	if err != nil {
		return err
	}
	if streamID&1 != parity {
		return protocolError(
			"stream_id_parity",
			"stream ID %d has the wrong parity for %s",
			streamID,
			creator,
		)
	}
	return nil
}

func AcceptStreamID(creator Creator, highest uint64, streamID uint64) (uint64, error) {
	if err := validateCreatorStreamID(creator, streamID); err != nil {
		return highest, err
	}
	if streamID <= highest {
		return highest, protocolError(
			"stream_id_reused",
			"REQUEST_START stream ID must exceed its creator's high-water mark",
		)
	}
	return streamID, nil
}

func NextStreamID(creator Creator, highest uint64) (uint64, error) {
	first := uint64(1)
	if creator == CreatorHelper {
		first = 2
	} else if creator != CreatorNode {
		return 0, protocolError("stream_id_parity", "unknown stream creator %q", creator)
	}
	if highest == 0 {
		return first, nil
	}
	if err := validateCreatorStreamID(creator, highest); err != nil {
		return 0, err
	}
	if highest > math.MaxUint64-2 {
		return 0, protocolError("stream_id_exhausted", "WIPC stream ID space is exhausted before wraparound")
	}
	return highest + 2, nil
}

var parentAuthDomain = []byte("waifus-ipc-auth-v1")
var helperAuthDomain = []byte("waifus-ipc-helper-v1")

func validateAuthInputs(
	capability []byte,
	clientNonce []byte,
	helperNonce []byte,
	hello []byte,
	helloAck []byte,
) error {
	for name, value := range map[string][]byte{
		"parentCapability": capability,
		"clientNonce":      clientNonce,
		"helperNonce":      helperNonce,
	} {
		if len(value) != authValueBytes {
			return protocolError("invalid_auth_width", "%s must contain exactly 32 bytes", name)
		}
	}
	for name, value := range map[string][]byte{"helloBytes": hello, "helloAckBytes": helloAck} {
		if len(value) == 0 || len(value) > ControlPayloadMaxBytes {
			return protocolError(
				"invalid_auth_transcript",
				"%s must contain 1 to 32 KiB of exact control bytes",
				name,
			)
		}
	}
	return nil
}

func transcriptHMAC(
	domain []byte,
	capability []byte,
	clientNonce []byte,
	helperNonce []byte,
	hello []byte,
	helloAck []byte,
) ([]byte, error) {
	if err := validateAuthInputs(capability, clientNonce, helperNonce, hello, helloAck); err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, capability)
	_, _ = mac.Write(domain)
	_, _ = mac.Write(clientNonce)
	_, _ = mac.Write(helperNonce)
	_, _ = mac.Write(hello)
	_, _ = mac.Write(helloAck)
	return mac.Sum(nil), nil
}

func ParentProof(
	capability []byte,
	clientNonce []byte,
	helperNonce []byte,
	hello []byte,
	helloAck []byte,
) ([]byte, error) {
	return transcriptHMAC(parentAuthDomain, capability, clientNonce, helperNonce, hello, helloAck)
}

func HelperProof(
	capability []byte,
	clientNonce []byte,
	helperNonce []byte,
	hello []byte,
	helloAck []byte,
	parentProof []byte,
) ([]byte, error) {
	if len(parentProof) != authValueBytes {
		return nil, protocolError("invalid_auth_width", "parentProof must contain exactly 32 bytes")
	}
	if err := validateAuthInputs(capability, clientNonce, helperNonce, hello, helloAck); err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, capability)
	_, _ = mac.Write(helperAuthDomain)
	_, _ = mac.Write(clientNonce)
	_, _ = mac.Write(helperNonce)
	_, _ = mac.Write(hello)
	_, _ = mac.Write(helloAck)
	_, _ = mac.Write(parentProof)
	return mac.Sum(nil), nil
}

func VerifyParentProof(
	capability []byte,
	clientNonce []byte,
	helperNonce []byte,
	hello []byte,
	helloAck []byte,
	proof []byte,
) (bool, error) {
	if len(proof) != authValueBytes {
		return false, protocolError("invalid_auth_width", "parentProof must contain exactly 32 bytes")
	}
	expected, err := ParentProof(capability, clientNonce, helperNonce, hello, helloAck)
	if err != nil {
		return false, err
	}
	return hmac.Equal(expected, proof), nil
}

func VerifyHelperProof(
	capability []byte,
	clientNonce []byte,
	helperNonce []byte,
	hello []byte,
	helloAck []byte,
	parentProof []byte,
	proof []byte,
) (bool, error) {
	if len(proof) != authValueBytes {
		return false, protocolError("invalid_auth_width", "helperProof must contain exactly 32 bytes")
	}
	expected, err := HelperProof(
		capability,
		clientNonce,
		helperNonce,
		hello,
		helloAck,
		parentProof,
	)
	if err != nil {
		return false, err
	}
	return hmac.Equal(expected, proof), nil
}
