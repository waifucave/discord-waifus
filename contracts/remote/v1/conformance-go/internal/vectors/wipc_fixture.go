package vectors

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/wipc"
)

type ProtocolVersion struct {
	Major uint16 `json:"major"`
	Minor uint16 `json:"minor"`
}

type WIPCLimits struct {
	AbsolutePayloadBytes     int `json:"absolutePayloadBytes"`
	ControlPayloadBytes      int `json:"controlPayloadBytes"`
	DataPayloadBytes         int `json:"dataPayloadBytes"`
	EncodedHeadersBytes      int `json:"encodedHeadersBytes"`
	HeaderBytes              int `json:"headerBytes"`
	InitialStreamCreditBytes int `json:"initialStreamCreditBytes"`
	MaxConcurrentStreams     int `json:"maxConcurrentStreams"`
	WindowUpdateBytes        int `json:"windowUpdateBytes"`
}

type WIPCFrameTypes struct {
	Hello         uint8 `json:"hello"`
	HelloAck      uint8 `json:"helloAck"`
	Command       uint8 `json:"command"`
	Result        uint8 `json:"result"`
	Event         uint8 `json:"event"`
	RequestStart  uint8 `json:"requestStart"`
	RequestChunk  uint8 `json:"requestChunk"`
	RequestEnd    uint8 `json:"requestEnd"`
	RequestCancel uint8 `json:"requestCancel"`
	ResponseStart uint8 `json:"responseStart"`
	ResponseChunk uint8 `json:"responseChunk"`
	ResponseEnd   uint8 `json:"responseEnd"`
	ResponseError uint8 `json:"responseError"`
	WindowUpdate  uint8 `json:"windowUpdate"`
}

type HeaderFields struct {
	Major         uint16 `json:"major"`
	Minor         uint16 `json:"minor"`
	FrameType     uint8  `json:"frameType"`
	Flags         uint8  `json:"flags"`
	StreamID      string `json:"streamId"`
	PayloadLength uint32 `json:"payloadLength"`
}

type HeaderVector struct {
	Name    string       `json:"name"`
	Fields  HeaderFields `json:"fields"`
	WireHex string       `json:"wireHex"`
}

type InvalidWireVector struct {
	Name      string `json:"name"`
	WireHex   string `json:"wireHex"`
	ErrorCode string `json:"errorCode"`
}

type WindowUpdateVector struct {
	Direction       string `json:"direction"`
	CreditIncrement uint32 `json:"creditIncrement"`
	WireHex         string `json:"wireHex"`
}

type AuthRejectionVector struct {
	Name          string `json:"name"`
	ProofKind     string `json:"proofKind"`
	HelloBytesB64 string `json:"helloBytesB64"`
	ProofB64      string `json:"proofB64"`
	Outcome       string `json:"outcome"`
}

type AuthenticationFixture struct {
	ParentCapabilityB64 string                `json:"parentCapabilityB64"`
	ClientNonceB64      string                `json:"clientNonceB64"`
	HelperNonceB64      string                `json:"helperNonceB64"`
	HelloBytesB64       string                `json:"helloBytesB64"`
	HelloAckBytesB64    string                `json:"helloAckBytesB64"`
	ParentProofB64      string                `json:"parentProofB64"`
	HelperProofB64      string                `json:"helperProofB64"`
	RejectionVectors    []AuthRejectionVector `json:"rejectionVectors"`
}

type StreamIDVector struct {
	Creator       string `json:"creator"`
	HighestBefore string `json:"highestBefore"`
	StreamID      string `json:"streamId"`
	Outcome       string `json:"outcome"`
	HighestAfter  string `json:"highestAfter"`
}

type AllocatorVector struct {
	Creator       string `json:"creator"`
	HighestBefore string `json:"highestBefore"`
	NextStreamID  string `json:"nextStreamId,omitempty"`
	Outcome       string `json:"outcome"`
}

type WIPCV1Fixture struct {
	SchemaVersion        int                   `json:"schemaVersion"`
	Protocol             ProtocolVersion       `json:"protocol"`
	Limits               WIPCLimits            `json:"limits"`
	FrameTypes           WIPCFrameTypes        `json:"frameTypes"`
	ValidHeaders         []HeaderVector        `json:"validHeaders"`
	InvalidHeaders       []InvalidWireVector   `json:"invalidHeaders"`
	ValidWindowUpdates   []WindowUpdateVector  `json:"validWindowUpdates"`
	InvalidWindowUpdates []InvalidWireVector   `json:"invalidWindowUpdates"`
	StreamIDVectors      []StreamIDVector      `json:"streamIdVectors"`
	AllocatorVectors     []AllocatorVector     `json:"allocatorVectors"`
	Authentication       AuthenticationFixture `json:"authentication"`
}

func encodeHeaderVector(name string, frameType wipc.FrameType, streamID uint64, payloadLength uint32) (HeaderVector, error) {
	header := wipc.Header{
		Major:         wipc.ProtocolMajor,
		Minor:         wipc.ProtocolMinor,
		FrameType:     uint8(frameType),
		Flags:         0,
		StreamID:      streamID,
		PayloadLength: payloadLength,
	}
	wire, err := wipc.EncodeHeader(header)
	if err != nil {
		return HeaderVector{}, fmt.Errorf("encode %s header: %w", name, err)
	}
	return HeaderVector{
		Name: name,
		Fields: HeaderFields{
			Major:         header.Major,
			Minor:         header.Minor,
			FrameType:     header.FrameType,
			Flags:         header.Flags,
			StreamID:      fmt.Sprintf("%d", header.StreamID),
			PayloadLength: header.PayloadLength,
		},
		WireHex: hex.EncodeToString(wire),
	}, nil
}

func cloneAndMutate(source []byte, mutation func([]byte)) []byte {
	cloned := append([]byte(nil), source...)
	mutation(cloned)
	return cloned
}

func baseHeader(frameType wipc.FrameType, streamID uint64, payloadLength uint32) ([]byte, error) {
	return wipc.EncodeHeader(wipc.Header{
		Major:         wipc.ProtocolMajor,
		Minor:         wipc.ProtocolMinor,
		FrameType:     uint8(frameType),
		Flags:         0,
		StreamID:      streamID,
		PayloadLength: payloadLength,
	})
}

func buildValidHeaders() ([]HeaderVector, error) {
	definitions := []struct {
		name          string
		frameType     wipc.FrameType
		streamID      uint64
		payloadLength uint32
	}{
		{"hello", wipc.FrameHello, 0, 2},
		{"hello-ack", wipc.FrameHelloAck, 0, 2},
		{"command", wipc.FrameCommand, 0, 2},
		{"result", wipc.FrameResult, 0, 2},
		{"event", wipc.FrameEvent, 0, wipc.ControlPayloadMaxBytes},
		{"request-start", wipc.FrameRequestStart, 1, 321},
		{"request-chunk", wipc.FrameRequestChunk, 1, wipc.DataPayloadMaxBytes},
		{"request-end", wipc.FrameRequestEnd, 1, 0},
		{"request-cancel", wipc.FrameRequestCancel, 1, 2},
		{"response-start", wipc.FrameResponseStart, 1, 2},
		{"response-chunk", wipc.FrameResponseChunk, 1, wipc.DataPayloadMaxBytes},
		{"response-end", wipc.FrameResponseEnd, 1, 0},
		{"response-error", wipc.FrameResponseError, 1, 2},
		{"window-update", wipc.FrameWindowUpdate, 1, wipc.WindowUpdateBytes},
	}
	vectors := make([]HeaderVector, 0, len(definitions))
	for _, definition := range definitions {
		vector, err := encodeHeaderVector(
			definition.name,
			definition.frameType,
			definition.streamID,
			definition.payloadLength,
		)
		if err != nil {
			return nil, err
		}
		vectors = append(vectors, vector)
	}
	return vectors, nil
}

func buildInvalidHeaders() ([]InvalidWireVector, error) {
	requestChunk, err := baseHeader(wipc.FrameRequestChunk, 1, wipc.DataPayloadMaxBytes)
	if err != nil {
		return nil, err
	}
	hello, err := baseHeader(wipc.FrameHello, 0, 2)
	if err != nil {
		return nil, err
	}
	requestStart, err := baseHeader(wipc.FrameRequestStart, 1, 2)
	if err != nil {
		return nil, err
	}
	event, err := baseHeader(wipc.FrameEvent, 0, 2)
	if err != nil {
		return nil, err
	}
	responseEnd, err := baseHeader(wipc.FrameResponseEnd, 1, 0)
	if err != nil {
		return nil, err
	}
	windowUpdate, err := baseHeader(wipc.FrameWindowUpdate, 1, wipc.WindowUpdateBytes)
	if err != nil {
		return nil, err
	}

	vector := func(name string, wire []byte, errorCode string) InvalidWireVector {
		return InvalidWireVector{Name: name, WireHex: hex.EncodeToString(wire), ErrorCode: errorCode}
	}
	return []InvalidWireVector{
		vector("short-header", requestChunk[:wipc.HeaderBytes-1], "invalid_header_length"),
		vector("wrong-magic", cloneAndMutate(requestChunk, func(value []byte) { value[0] = 0 }), "invalid_magic"),
		vector("unsupported-version", cloneAndMutate(requestChunk, func(value []byte) {
			value[4], value[5] = 0, 2
		}), "unsupported_version"),
		vector("unknown-frame-type", cloneAndMutate(requestChunk, func(value []byte) {
			value[8] = 0xff
		}), "unknown_frame_type"),
		vector("reserved-flag", cloneAndMutate(requestChunk, func(value []byte) {
			value[9] = 1
		}), "reserved_flags"),
		vector("nonzero-reserved-header", cloneAndMutate(requestChunk, func(value []byte) {
			value[11] = 1
		}), "reserved_bytes"),
		vector("connection-frame-on-stream", cloneAndMutate(hello, func(value []byte) {
			value[19] = 1
		}), "invalid_stream_id"),
		vector("stream-frame-on-zero", cloneAndMutate(requestStart, func(value []byte) {
			for index := 12; index < 20; index++ {
				value[index] = 0
			}
		}), "invalid_stream_id"),
		vector("absolute-payload-overflow", cloneAndMutate(requestChunk, func(value []byte) {
			value[20], value[21], value[22], value[23] = 0, 1, 0, 1
		}), "payload_too_large"),
		vector("control-payload-overflow", cloneAndMutate(event, func(value []byte) {
			value[20], value[21], value[22], value[23] = 0, 0, 128, 1
		}), "control_payload_too_large"),
		vector("empty-data-frame", cloneAndMutate(requestChunk, func(value []byte) {
			value[20], value[21], value[22], value[23] = 0, 0, 0, 0
		}), "invalid_data_payload_length"),
		vector("terminal-with-payload", cloneAndMutate(responseEnd, func(value []byte) {
			value[23] = 1
		}), "invalid_terminal_payload_length"),
		vector("wrong-window-update-length", cloneAndMutate(windowUpdate, func(value []byte) {
			value[23] = wipc.WindowUpdateBytes - 1
		}), "invalid_window_update_length"),
	}, nil
}

func buildWindowUpdates() ([]WindowUpdateVector, []InvalidWireVector, error) {
	request, err := wipc.EncodeWindowUpdate(wipc.WindowUpdate{
		Direction:       wipc.DirectionRequest,
		CreditIncrement: wipc.InitialStreamCreditBytes,
	})
	if err != nil {
		return nil, nil, err
	}
	response, err := wipc.EncodeWindowUpdate(wipc.WindowUpdate{
		Direction:       wipc.DirectionResponse,
		CreditIncrement: 1,
	})
	if err != nil {
		return nil, nil, err
	}
	base, err := wipc.EncodeWindowUpdate(wipc.WindowUpdate{
		Direction:       wipc.DirectionRequest,
		CreditIncrement: 1,
	})
	if err != nil {
		return nil, nil, err
	}
	valid := []WindowUpdateVector{
		{
			Direction:       "request",
			CreditIncrement: wipc.InitialStreamCreditBytes,
			WireHex:         hex.EncodeToString(request),
		},
		{Direction: "response", CreditIncrement: 1, WireHex: hex.EncodeToString(response)},
	}
	vector := func(name string, wire []byte, errorCode string) InvalidWireVector {
		return InvalidWireVector{Name: name, WireHex: hex.EncodeToString(wire), ErrorCode: errorCode}
	}
	invalid := []InvalidWireVector{
		vector("short-window-update", base[:wipc.WindowUpdateBytes-1], "invalid_window_update_length"),
		vector("unknown-window-direction", cloneAndMutate(base, func(value []byte) {
			value[0] = 3
		}), "invalid_window_direction"),
		vector("nonzero-window-reserved", cloneAndMutate(base, func(value []byte) {
			value[2] = 1
		}), "reserved_bytes"),
		vector("zero-window-credit", cloneAndMutate(base, func(value []byte) {
			value[4], value[5], value[6], value[7] = 0, 0, 0, 0
		}), "invalid_credit_increment"),
		vector("excess-window-credit", cloneAndMutate(base, func(value []byte) {
			value[4], value[5], value[6], value[7] = 0, 16, 0, 1
		}), "invalid_credit_increment"),
	}
	return valid, invalid, nil
}

func sequentialBytes(start byte) []byte {
	value := make([]byte, 32)
	for index := range value {
		value[index] = start + byte(index)
	}
	return value
}

func buildAuthentication() (AuthenticationFixture, error) {
	capability := sequentialBytes(0x00)
	clientNonce := sequentialBytes(0x20)
	helperNonce := sequentialBytes(0x40)
	hello := []byte(`{"component":"discord_waifus","nonce":"client","protocol":{"major":1,"minor":0}}`)
	helloAck := []byte(`{"component":"ts_connect","nonce":"helper","protocol":{"major":1,"minor":0}}`)
	parentProof, err := wipc.ParentProof(capability, clientNonce, helperNonce, hello, helloAck)
	if err != nil {
		return AuthenticationFixture{}, err
	}
	helperProof, err := wipc.HelperProof(
		capability,
		clientNonce,
		helperNonce,
		hello,
		helloAck,
		parentProof,
	)
	if err != nil {
		return AuthenticationFixture{}, err
	}
	wrongHelperProof := append([]byte(nil), helperProof...)
	wrongHelperProof[0] ^= 1
	replayedHello := append(append([]byte(nil), hello...), ' ')
	encode := base64.RawURLEncoding.EncodeToString
	return AuthenticationFixture{
		ParentCapabilityB64: encode(capability),
		ClientNonceB64:      encode(clientNonce),
		HelperNonceB64:      encode(helperNonce),
		HelloBytesB64:       encode(hello),
		HelloAckBytesB64:    encode(helloAck),
		ParentProofB64:      encode(parentProof),
		HelperProofB64:      encode(helperProof),
		RejectionVectors: []AuthRejectionVector{
			{
				Name:          "wrong-helper-proof",
				ProofKind:     "helper",
				HelloBytesB64: encode(hello),
				ProofB64:      encode(wrongHelperProof),
				Outcome:       "reject",
			},
			{
				Name:          "reflected-parent-proof",
				ProofKind:     "helper",
				HelloBytesB64: encode(hello),
				ProofB64:      encode(parentProof),
				Outcome:       "reject",
			},
			{
				Name:          "replayed-proof-on-changed-hello",
				ProofKind:     "parent",
				HelloBytesB64: encode(replayedHello),
				ProofB64:      encode(parentProof),
				Outcome:       "reject",
			},
		},
	}, nil
}

func BuildWIPCV1Fixture() (WIPCV1Fixture, error) {
	validHeaders, err := buildValidHeaders()
	if err != nil {
		return WIPCV1Fixture{}, err
	}
	invalidHeaders, err := buildInvalidHeaders()
	if err != nil {
		return WIPCV1Fixture{}, err
	}
	validWindowUpdates, invalidWindowUpdates, err := buildWindowUpdates()
	if err != nil {
		return WIPCV1Fixture{}, err
	}
	authentication, err := buildAuthentication()
	if err != nil {
		return WIPCV1Fixture{}, err
	}
	return WIPCV1Fixture{
		SchemaVersion: 1,
		Protocol: ProtocolVersion{
			Major: wipc.ProtocolMajor,
			Minor: wipc.ProtocolMinor,
		},
		Limits: WIPCLimits{
			AbsolutePayloadBytes:     wipc.AbsolutePayloadMaxBytes,
			ControlPayloadBytes:      wipc.ControlPayloadMaxBytes,
			DataPayloadBytes:         wipc.DataPayloadMaxBytes,
			EncodedHeadersBytes:      wipc.EncodedHeadersMaxBytes,
			HeaderBytes:              wipc.HeaderBytes,
			InitialStreamCreditBytes: wipc.InitialStreamCreditBytes,
			MaxConcurrentStreams:     wipc.MaxConcurrentStreams,
			WindowUpdateBytes:        wipc.WindowUpdateBytes,
		},
		FrameTypes: WIPCFrameTypes{
			Hello:         uint8(wipc.FrameHello),
			HelloAck:      uint8(wipc.FrameHelloAck),
			Command:       uint8(wipc.FrameCommand),
			Result:        uint8(wipc.FrameResult),
			Event:         uint8(wipc.FrameEvent),
			RequestStart:  uint8(wipc.FrameRequestStart),
			RequestChunk:  uint8(wipc.FrameRequestChunk),
			RequestEnd:    uint8(wipc.FrameRequestEnd),
			RequestCancel: uint8(wipc.FrameRequestCancel),
			ResponseStart: uint8(wipc.FrameResponseStart),
			ResponseChunk: uint8(wipc.FrameResponseChunk),
			ResponseEnd:   uint8(wipc.FrameResponseEnd),
			ResponseError: uint8(wipc.FrameResponseError),
			WindowUpdate:  uint8(wipc.FrameWindowUpdate),
		},
		ValidHeaders:         validHeaders,
		InvalidHeaders:       invalidHeaders,
		ValidWindowUpdates:   validWindowUpdates,
		InvalidWindowUpdates: invalidWindowUpdates,
		StreamIDVectors: []StreamIDVector{
			{
				Creator: "node", HighestBefore: "0", StreamID: "1", Outcome: "accept", HighestAfter: "1",
			},
			{
				Creator: "helper", HighestBefore: "0", StreamID: "2", Outcome: "accept", HighestAfter: "2",
			},
			{
				Creator: "node", HighestBefore: "1", StreamID: "9007199254740993", Outcome: "accept", HighestAfter: "9007199254740993",
			},
			{
				Creator: "helper", HighestBefore: "2", StreamID: "18446744073709551614", Outcome: "accept", HighestAfter: "18446744073709551614",
			},
			{
				Creator: "node", HighestBefore: "9", StreamID: "3", Outcome: "stream_id_reused", HighestAfter: "9",
			},
			{
				Creator: "node", HighestBefore: "9", StreamID: "10", Outcome: "stream_id_parity", HighestAfter: "9",
			},
		},
		AllocatorVectors: []AllocatorVector{
			{Creator: "node", HighestBefore: "0", NextStreamID: "1", Outcome: "accept"},
			{Creator: "helper", HighestBefore: "0", NextStreamID: "2", Outcome: "accept"},
			{
				Creator: "node", HighestBefore: "18446744073709551613", NextStreamID: "18446744073709551615", Outcome: "accept",
			},
			{
				Creator: "helper", HighestBefore: "18446744073709551612", NextStreamID: "18446744073709551614", Outcome: "accept",
			},
			{Creator: "node", HighestBefore: "18446744073709551615", Outcome: "stream_id_exhausted"},
			{Creator: "helper", HighestBefore: "18446744073709551614", Outcome: "stream_id_exhausted"},
		},
		Authentication: authentication,
	}, nil
}

func canonicalJSON(value any) ([]byte, error) {
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

func BuildWIPCV1JSON() ([]byte, error) {
	fixture, err := BuildWIPCV1Fixture()
	if err != nil {
		return nil, err
	}
	return canonicalJSON(fixture)
}

func DecodeWIPCV1Fixture(encoded []byte) (WIPCV1Fixture, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var fixture WIPCV1Fixture
	if err := decoder.Decode(&fixture); err != nil {
		return WIPCV1Fixture{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return WIPCV1Fixture{}, fmt.Errorf("unexpected trailing JSON value")
		}
		return WIPCV1Fixture{}, fmt.Errorf("read trailing JSON: %w", err)
	}
	return fixture, nil
}
