package conformance_test

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/vectors"
	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/wipc"
)

func stateFixtureBytes(t *testing.T) []byte {
	t.Helper()
	value, err := os.ReadFile(filepath.Join("..", "..", "fixtures", "crypto", "wipc-state-v1.json"))
	if err != nil {
		t.Fatalf("read committed WIPC state fixture: %v", err)
	}
	return value
}

func TestGoGeneratorMatchesCommittedWIPCStateV1Fixture(t *testing.T) {
	expected, err := vectors.BuildWIPCStateV1JSON()
	if err != nil {
		t.Fatalf("build WIPC state fixture: %v", err)
	}
	actual := stateFixtureBytes(t)
	if !bytes.Equal(actual, expected) {
		t.Fatalf("Go-generated WIPC state fixture differs from committed bytes")
	}
}

func TestWIPCStateRejectsFramesBeforeAuthentication(t *testing.T) {
	connection := wipc.NewConnectionState()
	_, err := connection.Receive(wipc.ReceivedFrame{
		Sender:    wipc.CreatorNode,
		FrameType: uint8(wipc.FrameRequestStart),
		StreamID:  1,
	})
	if err == nil {
		t.Fatalf("stream frame before authentication was accepted")
	}
	if got := protocolErrorCode(t, err); got != "frame_before_authentication" {
		t.Fatalf("error code = %q, want frame_before_authentication", got)
	}
}

func assertStateSnapshot(t *testing.T, actual wipc.StreamSnapshot, expected vectors.StateSnapshot) {
	t.Helper()
	if string(actual.Initiator) != expected.Initiator ||
		actual.RequestState != expected.RequestState ||
		actual.ResponseState != expected.ResponseState ||
		actual.Cancelled != expected.Cancelled ||
		actual.ProtocolFailed != expected.ProtocolFailed ||
		actual.RequestCredit != expected.RequestCredit ||
		actual.ResponseCredit != expected.ResponseCredit {
		t.Fatalf("snapshot mismatch:\nactual:   %#v\nexpected: %#v", actual, expected)
	}
}

func TestWIPCStateScenarios(t *testing.T) {
	fixture, err := vectors.DecodeWIPCStateV1Fixture(stateFixtureBytes(t))
	if err != nil {
		t.Fatalf("decode state fixture: %v", err)
	}

	for _, scenario := range fixture.Scenarios {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			connection := wipc.NewConnectionState()
			connection.MarkAuthenticated()
			for _, step := range scenario.Steps {
				streamID := parseUint64(t, step.StreamID)
				if step.Action == "remove" {
					if err := connection.RemoveStream(streamID); err != nil {
						t.Fatalf("remove stream: %v", err)
					}
					if step.ExpectedOutcome != "removed" {
						t.Fatalf("remove expected outcome = %q", step.ExpectedOutcome)
					}
				} else {
					frame := wipc.ReceivedFrame{
						Sender:        wipc.Creator(step.Sender),
						FrameType:     step.FrameType,
						StreamID:      streamID,
						PayloadLength: step.PayloadLength,
					}
					if step.WindowUpdate != nil {
						frame.WindowUpdate = &wipc.WindowUpdate{
							Direction:       wipc.DirectionFromString(step.WindowUpdate.Direction),
							CreditIncrement: step.WindowUpdate.CreditIncrement,
						}
					}
					repeat := step.Repeat
					if repeat == 0 {
						repeat = 1
					}
					if step.ExpectedConnectionError != "" {
						_, err := connection.Receive(frame)
						if err == nil {
							t.Fatalf("expected connection error %q", step.ExpectedConnectionError)
						}
						if got := protocolErrorCode(t, err); got != step.ExpectedConnectionError {
							t.Fatalf("connection error = %q, want %q", got, step.ExpectedConnectionError)
						}
					} else {
						for index := 0; index < repeat; index++ {
							transition, err := connection.Receive(frame)
							if err != nil {
								t.Fatalf("receive step: %v", err)
							}
							if transition.Outcome != step.ExpectedOutcome {
								t.Fatalf("outcome = %q, want %q", transition.Outcome, step.ExpectedOutcome)
							}
							if step.ExpectedStreamError != "" && transition.ErrorCode != step.ExpectedStreamError {
								t.Fatalf("stream error = %q, want %q", transition.ErrorCode, step.ExpectedStreamError)
							}
							if step.ExpectedDispatch != nil && transition.Dispatch != *step.ExpectedDispatch {
								t.Fatalf("dispatch = %t, want %t", transition.Dispatch, *step.ExpectedDispatch)
							}
							if step.ExpectedAbortRequest != nil && transition.AbortRequest != *step.ExpectedAbortRequest {
								t.Fatalf("abortRequest = %t, want %t", transition.AbortRequest, *step.ExpectedAbortRequest)
							}
							if step.ExpectedCloseRequestInput != nil && transition.CloseRequestInput != *step.ExpectedCloseRequestInput {
								t.Fatalf("closeRequestInput = %t, want %t", transition.CloseRequestInput, *step.ExpectedCloseRequestInput)
							}
							if step.ExpectedResponseErrorPermitted != nil && transition.ResponseErrorPermitted != *step.ExpectedResponseErrorPermitted {
								t.Fatalf("responseErrorPermitted = %t, want %t", transition.ResponseErrorPermitted, *step.ExpectedResponseErrorPermitted)
							}
						}
					}
				}
				if step.ExpectedSnapshot != nil {
					snapshot, ok := connection.Snapshot(streamID)
					if !ok {
						t.Fatalf("expected active stream %d", streamID)
					}
					assertStateSnapshot(t, snapshot, *step.ExpectedSnapshot)
				}
			}
		})
	}
}

func TestWIPCStateStreamLimitAdvancesHighWater(t *testing.T) {
	fixture, err := vectors.DecodeWIPCStateV1Fixture(stateFixtureBytes(t))
	if err != nil {
		t.Fatalf("decode state fixture: %v", err)
	}
	vector := fixture.StreamLimit
	connection := wipc.NewConnectionState()
	connection.MarkAuthenticated()
	first := parseUint64(t, vector.FirstStreamID)
	increment := parseUint64(t, vector.StreamIDIncrement)
	for index := 0; index < vector.AcceptedCount; index++ {
		streamID := first + uint64(index)*increment
		transition, err := connection.Receive(wipc.ReceivedFrame{
			Sender:    wipc.Creator(vector.Creator),
			FrameType: uint8(wipc.FrameRequestStart),
			StreamID:  streamID,
		})
		if err != nil || transition.Outcome != "request_started" {
			t.Fatalf("admit stream %d: transition=%#v error=%v", streamID, transition, err)
		}
	}
	rejected := parseUint64(t, vector.RejectedStreamID)
	transition, err := connection.Receive(wipc.ReceivedFrame{
		Sender:    wipc.Creator(vector.Creator),
		FrameType: uint8(wipc.FrameRequestStart),
		StreamID:  rejected,
	})
	if err != nil {
		t.Fatalf("stream-limit transition: %v", err)
	}
	if transition.Outcome != vector.ExpectedOutcome {
		t.Fatalf("stream-limit outcome = %q, want %q", transition.Outcome, vector.ExpectedOutcome)
	}
	if transition.Dispatch != vector.ExpectedDispatch {
		t.Fatalf("stream-limit dispatch = %t, want %t", transition.Dispatch, vector.ExpectedDispatch)
	}
	if connection.ActiveStreamCount() != vector.AcceptedCount {
		t.Fatalf("active streams = %d, want %d", connection.ActiveStreamCount(), vector.AcceptedCount)
	}
	highWater := connection.HighWaterSnapshot()
	expected := parseUint64(t, vector.ExpectedHighWater)
	if vector.Creator == "node" && highWater.HighestNodeStreamID != expected {
		t.Fatalf("node high water = %d, want %d", highWater.HighestNodeStreamID, expected)
	}
	if vector.Creator == "helper" && highWater.HighestHelperStreamID != expected {
		t.Fatalf("helper high water = %d, want %d", highWater.HighestHelperStreamID, expected)
	}

	_, err = connection.Receive(wipc.ReceivedFrame{
		Sender:    wipc.Creator(vector.Creator),
		FrameType: uint8(wipc.FrameRequestStart),
		StreamID:  rejected,
	})
	if err == nil {
		t.Fatalf("reused rejected stream ID was accepted")
	}
	var protocolError *wipc.ProtocolError
	if !errors.As(err, &protocolError) || protocolError.Code != "stream_id_reused" {
		t.Fatalf("reused stream error = %v", err)
	}
}
