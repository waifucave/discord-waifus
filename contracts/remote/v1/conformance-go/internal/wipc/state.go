package wipc

import "fmt"

type RequestState string

const (
	RequestOpen           RequestState = "open"
	RequestEnded          RequestState = "ended"
	RequestCancelled      RequestState = "cancelled"
	RequestResponseClosed RequestState = "response_closed"
	RequestFailed         RequestState = "failed"
)

type ResponseState string

const (
	ResponseNone      ResponseState = "none"
	ResponseOpen      ResponseState = "open"
	ResponseSucceeded ResponseState = "succeeded"
	ResponseFailed    ResponseState = "failed"
)

type ReceivedFrame struct {
	Sender        Creator
	FrameType     uint8
	StreamID      uint64
	PayloadLength uint32
	WindowUpdate  *WindowUpdate
}

type StreamSnapshot struct {
	Initiator      Creator
	RequestState   string
	ResponseState  string
	Cancelled      bool
	ProtocolFailed bool
	RequestCredit  uint32
	ResponseCredit uint32
}

type streamState struct {
	StreamSnapshot
	responder Creator
}

type Transition struct {
	Outcome                string
	StreamID               uint64
	Dispatch               bool
	ByteLength             uint32
	Direction              Direction
	AbortRequest           bool
	CloseRequestInput      bool
	ResponseErrorCode      string
	ErrorCode              string
	ResponseErrorPermitted bool
}

type HighWaterSnapshot struct {
	HighestNodeStreamID   uint64
	HighestHelperStreamID uint64
}

type ConnectionState struct {
	authenticated bool
	highWater     HighWaterSnapshot
	streams       map[uint64]*streamState
}

func NewConnectionState() *ConnectionState {
	return &ConnectionState{streams: make(map[uint64]*streamState)}
}

func (connection *ConnectionState) MarkAuthenticated() {
	connection.authenticated = true
}

func (connection *ConnectionState) ActiveStreamCount() int {
	return len(connection.streams)
}

func (connection *ConnectionState) HighWaterSnapshot() HighWaterSnapshot {
	return connection.highWater
}

func (connection *ConnectionState) Snapshot(streamID uint64) (StreamSnapshot, bool) {
	state, ok := connection.streams[streamID]
	if !ok {
		return StreamSnapshot{}, false
	}
	return state.StreamSnapshot, true
}

func responseTerminal(state *streamState) bool {
	return state.ResponseState == string(ResponseSucceeded) || state.ResponseState == string(ResponseFailed)
}

func requestTerminal(state *streamState) bool {
	return state.RequestState != string(RequestOpen)
}

func (connection *ConnectionState) RemoveStream(streamID uint64) error {
	state, ok := connection.streams[streamID]
	if !ok {
		return fmt.Errorf("cannot remove unknown WIPC stream %d", streamID)
	}
	if !state.ProtocolFailed && !responseTerminal(state) {
		return fmt.Errorf("cannot remove nonterminal WIPC stream %d", streamID)
	}
	delete(connection.streams, streamID)
	return nil
}

func creatorFromStreamID(streamID uint64) (Creator, error) {
	if streamID == 0 {
		return "", protocolError("invalid_stream_frame", "stream state requires a nonzero stream ID")
	}
	if streamID&1 == 1 {
		return CreatorNode, nil
	}
	return CreatorHelper, nil
}

func oppositeCreator(creator Creator) Creator {
	if creator == CreatorNode {
		return CreatorHelper
	}
	return CreatorNode
}

func DirectionFromString(value string) Direction {
	switch value {
	case "request":
		return DirectionRequest
	case "response":
		return DirectionResponse
	default:
		return 0
	}
}

func (connection *ConnectionState) Receive(frame ReceivedFrame) (Transition, error) {
	if !connection.authenticated {
		return Transition{}, protocolError(
			"frame_before_authentication",
			"no WIPC stream frame is accepted before mutual connection authentication",
		)
	}
	if frame.StreamID == 0 {
		return Transition{}, protocolError("invalid_stream_frame", "stream frames require a nonzero stream ID")
	}
	if FrameType(frame.FrameType) == FrameRequestStart {
		return connection.receiveRequestStart(frame)
	}
	state, ok := connection.streams[frame.StreamID]
	if !ok {
		return connection.receiveInactiveFrame(frame)
	}
	if state.ProtocolFailed {
		return connection.receiveFailedStreamFrame(state, frame)
	}
	switch FrameType(frame.FrameType) {
	case FrameRequestChunk:
		return connection.receiveRequestChunk(state, frame)
	case FrameRequestEnd:
		return connection.receiveRequestEnd(state, frame)
	case FrameRequestCancel:
		return connection.receiveRequestCancel(state, frame)
	case FrameResponseStart:
		return connection.receiveResponseStart(state, frame)
	case FrameResponseChunk:
		return connection.receiveResponseChunk(state, frame)
	case FrameResponseEnd:
		return connection.receiveResponseTerminal(state, frame, ResponseSucceeded)
	case FrameResponseError:
		return connection.receiveResponseTerminal(state, frame, ResponseFailed)
	case FrameWindowUpdate:
		return connection.receiveWindowUpdate(state, frame)
	default:
		return connection.failStream(state, frame.StreamID, "invalid_stream_frame"), nil
	}
}

func (connection *ConnectionState) receiveRequestStart(frame ReceivedFrame) (Transition, error) {
	highest := connection.highWater.HighestNodeStreamID
	if frame.Sender == CreatorHelper {
		highest = connection.highWater.HighestHelperStreamID
	}
	accepted, err := AcceptStreamID(frame.Sender, highest, frame.StreamID)
	if err != nil {
		return Transition{}, err
	}
	if frame.Sender == CreatorNode {
		connection.highWater.HighestNodeStreamID = accepted
	} else {
		connection.highWater.HighestHelperStreamID = accepted
	}
	if len(connection.streams) >= MaxConcurrentStreams {
		return Transition{
			Outcome:           "stream_limit",
			StreamID:          frame.StreamID,
			Dispatch:          false,
			ResponseErrorCode: "stream_limit",
		}, nil
	}
	connection.streams[frame.StreamID] = &streamState{
		StreamSnapshot: StreamSnapshot{
			Initiator:      frame.Sender,
			RequestState:   string(RequestOpen),
			ResponseState:  string(ResponseNone),
			Cancelled:      false,
			ProtocolFailed: false,
			RequestCredit:  InitialStreamCreditBytes,
			ResponseCredit: InitialStreamCreditBytes,
		},
		responder: oppositeCreator(frame.Sender),
	}
	return Transition{Outcome: "request_started", StreamID: frame.StreamID, Dispatch: true}, nil
}

func validateStateWindowUpdate(update *WindowUpdate) (*WindowUpdate, error) {
	if update == nil {
		return nil, protocolError("flow_control_error", "WINDOW_UPDATE is missing its decoded payload")
	}
	if err := validateWindowUpdate(*update); err != nil {
		return nil, protocolError("flow_control_error", "%s", err.Error())
	}
	return update, nil
}

func (connection *ConnectionState) receiveInactiveFrame(frame ReceivedFrame) (Transition, error) {
	initiator, err := creatorFromStreamID(frame.StreamID)
	if err != nil {
		return Transition{}, err
	}
	highest := connection.highWater.HighestNodeStreamID
	if initiator == CreatorHelper {
		highest = connection.highWater.HighestHelperStreamID
	}
	if frame.StreamID > highest {
		return Transition{}, protocolError("unknown_stream", "frame references unknown WIPC stream %d", frame.StreamID)
	}
	if FrameType(frame.FrameType) == FrameRequestCancel && frame.Sender == initiator {
		return Transition{Outcome: "inactive_frame_ignored", StreamID: frame.StreamID}, nil
	}
	if FrameType(frame.FrameType) == FrameWindowUpdate {
		update, err := validateStateWindowUpdate(frame.WindowUpdate)
		if err != nil {
			return Transition{}, err
		}
		expectedSender := initiator
		if update.Direction == DirectionRequest {
			expectedSender = oppositeCreator(initiator)
		}
		if frame.Sender != expectedSender {
			return Transition{}, protocolError("flow_control_error", "WINDOW_UPDATE was sent by the wrong stream side")
		}
		return Transition{
			Outcome:   "inactive_frame_ignored",
			StreamID:  frame.StreamID,
			Direction: update.Direction,
		}, nil
	}
	return Transition{}, protocolError("unknown_stream", "frame is forbidden for inactive WIPC stream %d", frame.StreamID)
}

func (connection *ConnectionState) receiveFailedStreamFrame(
	state *streamState,
	frame ReceivedFrame,
) (Transition, error) {
	if FrameType(frame.FrameType) == FrameRequestCancel && frame.Sender == state.Initiator {
		return Transition{Outcome: "cancel_ignored", StreamID: frame.StreamID, AbortRequest: false}, nil
	}
	if FrameType(frame.FrameType) == FrameWindowUpdate {
		return connection.receiveWindowUpdate(state, frame)
	}
	return Transition{}, protocolError(
		"failed_stream_frame",
		"non-cancel/non-window frame received on failed WIPC stream %d",
		frame.StreamID,
	)
}

func (connection *ConnectionState) expectedSenderFailure(
	state *streamState,
	frame ReceivedFrame,
	expected Creator,
) *Transition {
	if frame.Sender == expected {
		return nil
	}
	transition := connection.failStream(state, frame.StreamID, "unexpected_frame_sender")
	return &transition
}

func requireStateChunkLength(frame ReceivedFrame) (uint32, error) {
	if frame.PayloadLength == 0 || frame.PayloadLength > DataPayloadMaxBytes {
		return 0, protocolError(
			"invalid_stream_frame",
			"a WIPC chunk transition requires a decoded 1 to 65,536 byte payload length",
		)
	}
	return frame.PayloadLength, nil
}

func (connection *ConnectionState) receiveRequestChunk(
	state *streamState,
	frame ReceivedFrame,
) (Transition, error) {
	if failure := connection.expectedSenderFailure(state, frame, state.Initiator); failure != nil {
		return *failure, nil
	}
	byteLength, err := requireStateChunkLength(frame)
	if err != nil {
		return Transition{}, err
	}
	if state.RequestState == string(RequestEnded) || state.RequestState == string(RequestFailed) {
		return connection.failStream(state, frame.StreamID, "request_chunk_after_terminal"), nil
	}
	if err := connection.consumeCredit(state, DirectionRequest, byteLength); err != nil {
		return Transition{}, err
	}
	if state.RequestState == string(RequestCancelled) || state.RequestState == string(RequestResponseClosed) {
		return Transition{
			Outcome:    "request_chunk_discarded",
			StreamID:   frame.StreamID,
			ByteLength: byteLength,
		}, nil
	}
	return Transition{
		Outcome:    "request_chunk_delivered",
		StreamID:   frame.StreamID,
		ByteLength: byteLength,
	}, nil
}

func (connection *ConnectionState) receiveRequestEnd(
	state *streamState,
	frame ReceivedFrame,
) (Transition, error) {
	if failure := connection.expectedSenderFailure(state, frame, state.Initiator); failure != nil {
		return *failure, nil
	}
	if state.RequestState != string(RequestOpen) {
		return connection.failStream(state, frame.StreamID, "duplicate_request_end"), nil
	}
	state.RequestState = string(RequestEnded)
	return Transition{Outcome: "request_ended", StreamID: frame.StreamID}, nil
}

func (connection *ConnectionState) receiveRequestCancel(
	state *streamState,
	frame ReceivedFrame,
) (Transition, error) {
	if failure := connection.expectedSenderFailure(state, frame, state.Initiator); failure != nil {
		return *failure, nil
	}
	if state.Cancelled || responseTerminal(state) {
		return Transition{Outcome: "cancel_ignored", StreamID: frame.StreamID, AbortRequest: false}, nil
	}
	state.Cancelled = true
	state.RequestState = string(RequestCancelled)
	return Transition{Outcome: "request_cancelled", StreamID: frame.StreamID, AbortRequest: true}, nil
}

func (connection *ConnectionState) receiveResponseStart(
	state *streamState,
	frame ReceivedFrame,
) (Transition, error) {
	if failure := connection.expectedSenderFailure(state, frame, state.responder); failure != nil {
		return *failure, nil
	}
	if state.ResponseState != string(ResponseNone) {
		return connection.failStream(state, frame.StreamID, "duplicate_response_start"), nil
	}
	state.ResponseState = string(ResponseOpen)
	return Transition{Outcome: "response_started", StreamID: frame.StreamID}, nil
}

func (connection *ConnectionState) receiveResponseChunk(
	state *streamState,
	frame ReceivedFrame,
) (Transition, error) {
	if failure := connection.expectedSenderFailure(state, frame, state.responder); failure != nil {
		return *failure, nil
	}
	byteLength, err := requireStateChunkLength(frame)
	if err != nil {
		return Transition{}, err
	}
	if state.ResponseState == string(ResponseNone) {
		return connection.failStream(state, frame.StreamID, "response_chunk_before_start"), nil
	}
	if state.ResponseState != string(ResponseOpen) {
		return connection.failStream(state, frame.StreamID, "response_chunk_after_terminal"), nil
	}
	if err := connection.consumeCredit(state, DirectionResponse, byteLength); err != nil {
		return Transition{}, err
	}
	return Transition{
		Outcome:    "response_chunk_delivered",
		StreamID:   frame.StreamID,
		ByteLength: byteLength,
	}, nil
}

func (connection *ConnectionState) receiveResponseTerminal(
	state *streamState,
	frame ReceivedFrame,
	terminal ResponseState,
) (Transition, error) {
	if failure := connection.expectedSenderFailure(state, frame, state.responder); failure != nil {
		return *failure, nil
	}
	if terminal == ResponseSucceeded && state.ResponseState == string(ResponseNone) {
		return connection.failStream(state, frame.StreamID, "response_terminal_before_start"), nil
	}
	if responseTerminal(state) {
		return connection.failStream(state, frame.StreamID, "duplicate_response_terminal"), nil
	}
	state.ResponseState = string(terminal)
	closeRequestInput := state.RequestState == string(RequestOpen)
	if closeRequestInput {
		state.RequestState = string(RequestResponseClosed)
	}
	outcome := "response_ended"
	if terminal == ResponseFailed {
		outcome = "response_failed"
	}
	return Transition{
		Outcome:           outcome,
		StreamID:          frame.StreamID,
		CloseRequestInput: closeRequestInput,
	}, nil
}

func (connection *ConnectionState) receiveWindowUpdate(
	state *streamState,
	frame ReceivedFrame,
) (Transition, error) {
	update, err := validateStateWindowUpdate(frame.WindowUpdate)
	if err != nil {
		return Transition{}, err
	}
	expectedSender := state.Initiator
	if update.Direction == DirectionRequest {
		expectedSender = state.responder
	}
	if frame.Sender != expectedSender {
		return Transition{}, protocolError("flow_control_error", "WINDOW_UPDATE was sent by the wrong stream side")
	}
	terminal := responseTerminal(state) || state.ProtocolFailed
	if update.Direction == DirectionRequest {
		terminal = requestTerminal(state)
	}
	if terminal {
		return Transition{
			Outcome:   "window_ignored",
			StreamID:  frame.StreamID,
			Direction: update.Direction,
		}, nil
	}
	if update.Direction == DirectionRequest {
		if state.RequestCredit > InitialStreamCreditBytes-update.CreditIncrement {
			return Transition{}, protocolError(
				"flow_control_error",
				"WINDOW_UPDATE would exceed maximum outstanding credit",
			)
		}
		state.RequestCredit += update.CreditIncrement
	} else {
		if state.ResponseCredit > InitialStreamCreditBytes-update.CreditIncrement {
			return Transition{}, protocolError(
				"flow_control_error",
				"WINDOW_UPDATE would exceed maximum outstanding credit",
			)
		}
		state.ResponseCredit += update.CreditIncrement
	}
	return Transition{
		Outcome:   "window_updated",
		StreamID:  frame.StreamID,
		Direction: update.Direction,
	}, nil
}

func (connection *ConnectionState) consumeCredit(
	state *streamState,
	direction Direction,
	byteLength uint32,
) error {
	if direction == DirectionRequest {
		if byteLength > state.RequestCredit {
			return protocolError("flow_control_error", "request chunk exceeds outstanding stream credit")
		}
		state.RequestCredit -= byteLength
		return nil
	}
	if byteLength > state.ResponseCredit {
		return protocolError("flow_control_error", "response chunk exceeds outstanding stream credit")
	}
	state.ResponseCredit -= byteLength
	return nil
}

func (connection *ConnectionState) failStream(
	state *streamState,
	streamID uint64,
	errorCode string,
) Transition {
	responseErrorPermitted := !responseTerminal(state)
	abortRequest := !responseTerminal(state) || state.RequestState == string(RequestOpen)
	state.ProtocolFailed = true
	state.RequestState = string(RequestFailed)
	return Transition{
		Outcome:                "stream_failed",
		StreamID:               streamID,
		ErrorCode:              errorCode,
		ResponseErrorPermitted: responseErrorPermitted,
		AbortRequest:           abortRequest,
	}
}
