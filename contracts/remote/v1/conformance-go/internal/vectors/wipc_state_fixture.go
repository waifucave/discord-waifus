package vectors

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/wipc"
)

type StateSnapshot struct {
	Initiator      string `json:"initiator"`
	RequestState   string `json:"requestState"`
	ResponseState  string `json:"responseState"`
	Cancelled      bool   `json:"cancelled"`
	ProtocolFailed bool   `json:"protocolFailed"`
	RequestCredit  uint32 `json:"requestCredit"`
	ResponseCredit uint32 `json:"responseCredit"`
}

type StateWindowUpdate struct {
	Direction       string `json:"direction"`
	CreditIncrement uint32 `json:"creditIncrement"`
}

type StateStep struct {
	Action                         string             `json:"action"`
	Sender                         string             `json:"sender,omitempty"`
	FrameType                      uint8              `json:"frameType,omitempty"`
	StreamID                       string             `json:"streamId"`
	PayloadLength                  uint32             `json:"payloadLength,omitempty"`
	WindowUpdate                   *StateWindowUpdate `json:"windowUpdate,omitempty"`
	Repeat                         int                `json:"repeat,omitempty"`
	ExpectedOutcome                string             `json:"expectedOutcome"`
	ExpectedConnectionError        string             `json:"expectedConnectionError,omitempty"`
	ExpectedStreamError            string             `json:"expectedStreamError,omitempty"`
	ExpectedDispatch               *bool              `json:"expectedDispatch,omitempty"`
	ExpectedAbortRequest           *bool              `json:"expectedAbortRequest,omitempty"`
	ExpectedCloseRequestInput      *bool              `json:"expectedCloseRequestInput,omitempty"`
	ExpectedResponseErrorPermitted *bool              `json:"expectedResponseErrorPermitted,omitempty"`
	ExpectedSnapshot               *StateSnapshot     `json:"expectedSnapshot,omitempty"`
}

type StateScenario struct {
	Name  string      `json:"name"`
	Steps []StateStep `json:"steps"`
}

type StateStreamLimit struct {
	Creator           string `json:"creator"`
	FirstStreamID     string `json:"firstStreamId"`
	StreamIDIncrement string `json:"streamIdIncrement"`
	AcceptedCount     int    `json:"acceptedCount"`
	RejectedStreamID  string `json:"rejectedStreamId"`
	ExpectedOutcome   string `json:"expectedOutcome"`
	ExpectedDispatch  bool   `json:"expectedDispatch"`
	ExpectedHighWater string `json:"expectedHighWater"`
}

type WIPCStateV1Fixture struct {
	SchemaVersion            int              `json:"schemaVersion"`
	InitialStreamCreditBytes uint32           `json:"initialStreamCreditBytes"`
	MaxConcurrentStreams     int              `json:"maxConcurrentStreams"`
	Scenarios                []StateScenario  `json:"scenarios"`
	StreamLimit              StateStreamLimit `json:"streamLimit"`
}

func stateSnapshot(overrides ...func(*StateSnapshot)) *StateSnapshot {
	snapshot := &StateSnapshot{
		Initiator:      "node",
		RequestState:   "open",
		ResponseState:  "none",
		Cancelled:      false,
		ProtocolFailed: false,
		RequestCredit:  wipc.InitialStreamCreditBytes,
		ResponseCredit: wipc.InitialStreamCreditBytes,
	}
	for _, override := range overrides {
		override(snapshot)
	}
	return snapshot
}

func startNode() StateStep {
	return StateStep{
		Action:           "frame",
		Sender:           "node",
		FrameType:        uint8(wipc.FrameRequestStart),
		StreamID:         "1",
		ExpectedOutcome:  "request_started",
		ExpectedDispatch: boolPointer(true),
	}
}

func boolPointer(value bool) *bool {
	return &value
}

func BuildWIPCStateV1Fixture() WIPCStateV1Fixture {
	return WIPCStateV1Fixture{
		SchemaVersion:            1,
		InitialStreamCreditBytes: wipc.InitialStreamCreditBytes,
		MaxConcurrentStreams:     wipc.MaxConcurrentStreams,
		Scenarios: []StateScenario{
			{
				Name: "full-duplex-delayed-credit",
				Steps: []StateStep{
					func() StateStep {
						step := startNode()
						step.ExpectedSnapshot = stateSnapshot()
						return step
					}(),
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestChunk), StreamID: "1",
						PayloadLength: 60000, ExpectedOutcome: "request_chunk_delivered",
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) { value.RequestCredit = 988576 }),
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameWindowUpdate), StreamID: "1",
						WindowUpdate:    &StateWindowUpdate{Direction: "request", CreditIncrement: 60000},
						ExpectedOutcome: "window_updated", ExpectedSnapshot: stateSnapshot(),
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseStart), StreamID: "1",
						ExpectedOutcome:  "response_started",
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) { value.ResponseState = "open" }),
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseChunk), StreamID: "1",
						PayloadLength: 65536, ExpectedOutcome: "response_chunk_delivered",
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) {
							value.ResponseState = "open"
							value.ResponseCredit = 983040
						}),
					},
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameWindowUpdate), StreamID: "1",
						WindowUpdate:     &StateWindowUpdate{Direction: "response", CreditIncrement: 65536},
						ExpectedOutcome:  "window_updated",
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) { value.ResponseState = "open" }),
					},
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestEnd), StreamID: "1",
						ExpectedOutcome: "request_ended",
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) {
							value.RequestState = "ended"
							value.ResponseState = "open"
						}),
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseEnd), StreamID: "1",
						ExpectedOutcome:           "response_ended",
						ExpectedCloseRequestInput: boolPointer(false),
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) {
							value.RequestState = "ended"
							value.ResponseState = "succeeded"
						}),
					},
				},
			},
			{
				Name: "cancel-discard-remove-and-late-frames",
				Steps: []StateStep{
					startNode(),
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestCancel), StreamID: "1",
						ExpectedOutcome:      "request_cancelled",
						ExpectedAbortRequest: boolPointer(true),
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) {
							value.RequestState = "cancelled"
							value.Cancelled = true
						}),
					},
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestCancel), StreamID: "1",
						ExpectedOutcome:      "cancel_ignored",
						ExpectedAbortRequest: boolPointer(false),
					},
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestChunk), StreamID: "1",
						PayloadLength: 100, ExpectedOutcome: "request_chunk_discarded",
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) {
							value.RequestState = "cancelled"
							value.Cancelled = true
							value.RequestCredit = 1048476
						}),
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseError), StreamID: "1",
						ExpectedOutcome:           "response_failed",
						ExpectedCloseRequestInput: boolPointer(false),
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) {
							value.RequestState = "cancelled"
							value.ResponseState = "failed"
							value.Cancelled = true
							value.RequestCredit = 1048476
						}),
					},
					{Action: "remove", StreamID: "1", ExpectedOutcome: "removed"},
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestCancel), StreamID: "1",
						ExpectedOutcome: "inactive_frame_ignored",
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameWindowUpdate), StreamID: "1",
						WindowUpdate:    &StateWindowUpdate{Direction: "request", CreditIncrement: 1},
						ExpectedOutcome: "inactive_frame_ignored",
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseEnd), StreamID: "1",
						ExpectedOutcome: "connection_error", ExpectedConnectionError: "unknown_stream",
					},
				},
			},
			{
				Name: "response-terminal-closes-request-input",
				Steps: []StateStep{
					startNode(),
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseStart), StreamID: "1",
						ExpectedOutcome: "response_started",
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseEnd), StreamID: "1",
						ExpectedOutcome:           "response_ended",
						ExpectedCloseRequestInput: boolPointer(true),
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) {
							value.RequestState = "response_closed"
							value.ResponseState = "succeeded"
						}),
					},
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestChunk), StreamID: "1",
						PayloadLength: 10, ExpectedOutcome: "request_chunk_discarded",
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) {
							value.RequestState = "response_closed"
							value.ResponseState = "succeeded"
							value.RequestCredit = 1048566
						}),
					},
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestCancel), StreamID: "1",
						ExpectedOutcome:      "cancel_ignored",
						ExpectedAbortRequest: boolPointer(false),
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameWindowUpdate), StreamID: "1",
						WindowUpdate:    &StateWindowUpdate{Direction: "request", CreditIncrement: 10},
						ExpectedOutcome: "window_ignored",
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) {
							value.RequestState = "response_closed"
							value.ResponseState = "succeeded"
							value.RequestCredit = 1048566
						}),
					},
				},
			},
			{
				Name: "invalid-transition-escalates",
				Steps: []StateStep{
					startNode(),
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseChunk), StreamID: "1",
						PayloadLength: 1, ExpectedOutcome: "stream_failed",
						ExpectedStreamError:            "response_chunk_before_start",
						ExpectedAbortRequest:           boolPointer(true),
						ExpectedResponseErrorPermitted: boolPointer(true),
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) {
							value.RequestState = "failed"
							value.ProtocolFailed = true
						}),
					},
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestCancel), StreamID: "1",
						ExpectedOutcome:      "cancel_ignored",
						ExpectedAbortRequest: boolPointer(false),
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseChunk), StreamID: "1",
						PayloadLength: 1, ExpectedOutcome: "connection_error",
						ExpectedConnectionError: "failed_stream_frame",
					},
				},
			},
			{
				Name: "duplicate-request-terminal",
				Steps: []StateStep{
					startNode(),
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestEnd), StreamID: "1",
						ExpectedOutcome: "request_ended",
					},
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestEnd), StreamID: "1",
						ExpectedOutcome: "stream_failed", ExpectedStreamError: "duplicate_request_end",
					},
				},
			},
			{
				Name: "duplicate-response-start",
				Steps: []StateStep{
					startNode(),
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseStart), StreamID: "1",
						ExpectedOutcome: "response_started",
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseStart), StreamID: "1",
						ExpectedOutcome: "stream_failed", ExpectedStreamError: "duplicate_response_start",
					},
				},
			},
			{
				Name: "duplicate-response-terminal",
				Steps: []StateStep{
					startNode(),
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseStart), StreamID: "1",
						ExpectedOutcome: "response_started",
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseEnd), StreamID: "1",
						ExpectedOutcome: "response_ended",
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseError), StreamID: "1",
						ExpectedOutcome: "stream_failed", ExpectedStreamError: "duplicate_response_terminal",
						ExpectedAbortRequest: boolPointer(false), ExpectedResponseErrorPermitted: boolPointer(false),
					},
				},
			},
			{
				Name: "unexpected-frame-sender",
				Steps: []StateStep{
					startNode(),
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameRequestChunk), StreamID: "1",
						PayloadLength: 1, ExpectedOutcome: "stream_failed",
						ExpectedStreamError:  "unexpected_frame_sender",
						ExpectedAbortRequest: boolPointer(true), ExpectedResponseErrorPermitted: boolPointer(true),
					},
				},
			},
			{
				Name: "request-chunk-after-end",
				Steps: []StateStep{
					startNode(),
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestEnd), StreamID: "1",
						ExpectedOutcome: "request_ended",
					},
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestChunk), StreamID: "1",
						PayloadLength: 1, ExpectedOutcome: "stream_failed",
						ExpectedStreamError:  "request_chunk_after_terminal",
						ExpectedAbortRequest: boolPointer(true), ExpectedResponseErrorPermitted: boolPointer(true),
					},
				},
			},
			{
				Name: "response-terminal-before-start",
				Steps: []StateStep{
					startNode(),
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseEnd), StreamID: "1",
						ExpectedOutcome: "stream_failed", ExpectedStreamError: "response_terminal_before_start",
						ExpectedAbortRequest: boolPointer(true), ExpectedResponseErrorPermitted: boolPointer(true),
					},
				},
			},
			{
				Name: "response-chunk-after-terminal",
				Steps: []StateStep{
					startNode(),
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseStart), StreamID: "1",
						ExpectedOutcome: "response_started",
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseEnd), StreamID: "1",
						ExpectedOutcome: "response_ended",
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseChunk), StreamID: "1",
						PayloadLength: 1, ExpectedOutcome: "stream_failed",
						ExpectedStreamError:  "response_chunk_after_terminal",
						ExpectedAbortRequest: boolPointer(false), ExpectedResponseErrorPermitted: boolPointer(false),
					},
				},
			},
			{
				Name: "request-credit-overrun",
				Steps: []StateStep{
					startNode(),
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestChunk), StreamID: "1",
						PayloadLength: 65536, Repeat: 16, ExpectedOutcome: "request_chunk_delivered",
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) { value.RequestCredit = 0 }),
					},
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameRequestChunk), StreamID: "1",
						PayloadLength: 1, ExpectedOutcome: "connection_error",
						ExpectedConnectionError: "flow_control_error",
					},
				},
			},
			{
				Name: "response-credit-overrun",
				Steps: []StateStep{
					startNode(),
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseStart), StreamID: "1",
						ExpectedOutcome: "response_started",
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseChunk), StreamID: "1",
						PayloadLength: 65536, Repeat: 16, ExpectedOutcome: "response_chunk_delivered",
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) {
							value.ResponseState = "open"
							value.ResponseCredit = 0
						}),
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameResponseChunk), StreamID: "1",
						PayloadLength: 1, ExpectedOutcome: "connection_error",
						ExpectedConnectionError: "flow_control_error",
					},
				},
			},
			{
				Name: "wrong-side-window-update",
				Steps: []StateStep{
					startNode(),
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameWindowUpdate), StreamID: "1",
						WindowUpdate:    &StateWindowUpdate{Direction: "request", CreditIncrement: 1},
						ExpectedOutcome: "connection_error", ExpectedConnectionError: "flow_control_error",
					},
				},
			},
			{
				Name: "window-credit-overflow",
				Steps: []StateStep{
					startNode(),
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameWindowUpdate), StreamID: "1",
						WindowUpdate:    &StateWindowUpdate{Direction: "request", CreditIncrement: 1},
						ExpectedOutcome: "connection_error", ExpectedConnectionError: "flow_control_error",
					},
				},
			},
			{
				Name: "helper-created-stream-symmetry",
				Steps: []StateStep{
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameRequestStart), StreamID: "2",
						ExpectedOutcome:  "request_started",
						ExpectedDispatch: boolPointer(true),
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) { value.Initiator = "helper" }),
					},
					{
						Action: "frame", Sender: "helper", FrameType: uint8(wipc.FrameRequestChunk), StreamID: "2",
						PayloadLength: 1, ExpectedOutcome: "request_chunk_delivered",
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) {
							value.Initiator = "helper"
							value.RequestCredit = 1048575
						}),
					},
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameWindowUpdate), StreamID: "2",
						WindowUpdate:     &StateWindowUpdate{Direction: "request", CreditIncrement: 1},
						ExpectedOutcome:  "window_updated",
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) { value.Initiator = "helper" }),
					},
					{
						Action: "frame", Sender: "node", FrameType: uint8(wipc.FrameResponseError), StreamID: "2",
						ExpectedOutcome:           "response_failed",
						ExpectedCloseRequestInput: boolPointer(true),
						ExpectedSnapshot: stateSnapshot(func(value *StateSnapshot) {
							value.Initiator = "helper"
							value.RequestState = "response_closed"
							value.ResponseState = "failed"
						}),
					},
				},
			},
		},
		StreamLimit: StateStreamLimit{
			Creator:           "node",
			FirstStreamID:     "1",
			StreamIDIncrement: "2",
			AcceptedCount:     wipc.MaxConcurrentStreams,
			RejectedStreamID:  "257",
			ExpectedOutcome:   "stream_limit",
			ExpectedDispatch:  false,
			ExpectedHighWater: "257",
		},
	}
}

func BuildWIPCStateV1JSON() ([]byte, error) {
	return canonicalJSON(BuildWIPCStateV1Fixture())
}

func DecodeWIPCStateV1Fixture(encoded []byte) (WIPCStateV1Fixture, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var fixture WIPCStateV1Fixture
	if err := decoder.Decode(&fixture); err != nil {
		return WIPCStateV1Fixture{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return WIPCStateV1Fixture{}, fmt.Errorf("unexpected trailing JSON value")
		}
		return WIPCStateV1Fixture{}, fmt.Errorf("read trailing JSON: %w", err)
	}
	return fixture, nil
}
