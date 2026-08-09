package conformance_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/vectors"
)

func httpAuthFixtureBytes(t *testing.T) []byte {
	t.Helper()
	value, err := os.ReadFile(filepath.Join("..", "..", "fixtures", "crypto", "http-auth-envelope-v1.json"))
	if err != nil {
		t.Fatalf("read HTTP auth fixture: %v", err)
	}
	return value
}

func httpAuthFixture(t *testing.T) map[string]any {
	t.Helper()
	value, err := vectors.DecodeHttpAuthEnvelopeFixture(httpAuthFixtureBytes(t))
	if err != nil {
		t.Fatalf("decode HTTP auth fixture: %v", err)
	}
	return value
}

func httpObject(t *testing.T, value any, name string) map[string]any {
	t.Helper()
	result, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s must be an object, got %T", name, value)
	}
	return result
}

func httpArray(t *testing.T, value any, name string) []any {
	t.Helper()
	result, ok := value.([]any)
	if !ok {
		t.Fatalf("%s must be an array, got %T", name, value)
	}
	return result
}

func httpString(t *testing.T, value any, name string) string {
	t.Helper()
	result, ok := value.(string)
	if !ok {
		t.Fatalf("%s must be a string, got %T", name, value)
	}
	return result
}

func httpUint64(t *testing.T, value any, name string) uint64 {
	t.Helper()
	text := httpString(t, value, name)
	result, err := strconv.ParseUint(text, 10, 64)
	if err != nil || strconv.FormatUint(result, 10) != text {
		t.Fatalf("%s must be canonical uint64 %q: %v", name, text, err)
	}
	return result
}

func httpInt(t *testing.T, value any, name string) int {
	t.Helper()
	number, ok := value.(json.Number)
	if !ok {
		t.Fatalf("%s must be a JSON number, got %T", name, value)
	}
	result, err := strconv.Atoi(number.String())
	if err != nil || strconv.Itoa(result) != number.String() {
		t.Fatalf("%s must be an integer: %v", name, err)
	}
	return result
}

func httpHeaders(t *testing.T, value any) []pairing.HeaderTuple {
	t.Helper()
	entries := httpArray(t, value, "raw headers")
	result := make([]pairing.HeaderTuple, len(entries))
	for index, raw := range entries {
		tuple := httpArray(t, raw, "raw header tuple")
		if len(tuple) != 2 {
			t.Fatalf("raw header tuple %d has %d entries", index, len(tuple))
		}
		result[index] = pairing.HeaderTuple{
			httpString(t, tuple[0], "header name"),
			httpString(t, tuple[1], "header value"),
		}
	}
	return result
}

func httpWorkerKeys(t *testing.T, fixture map[string]any) map[string][]byte {
	t.Helper()
	worker := httpObject(t, fixture["worker"], "worker")
	return map[string][]byte{
		httpString(t, worker["keyId"], "Worker key ID"): decodeBase64URL(t, httpString(t, worker["publicKeyB64"], "Worker key")),
	}
}

func requireControlCode(t *testing.T, err error, expected, name string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s unexpectedly succeeded", name)
	}
	if actual := pairing.ControlAuthErrorCode(err); actual != expected {
		t.Fatalf("%s returned %q instead of %q: %v", name, actual, expected, err)
	}
}

func TestHTTPAuthFixtureExactBytes(t *testing.T) {
	expected, err := vectors.BuildHttpAuthEnvelopeV1JSON()
	if err != nil {
		t.Fatalf("build HTTP auth fixture: %v", err)
	}
	if actual := httpAuthFixtureBytes(t); !bytes.Equal(actual, expected) {
		limit := len(actual)
		if len(expected) < limit {
			limit = len(expected)
		}
		index := 0
		for index < limit && actual[index] == expected[index] {
			index++
		}
		t.Fatalf("HTTP auth fixture differs at byte %d (actual=%d expected=%d)", index, len(actual), len(expected))
	}
}

func TestActivationCertificateVerificationAndRejections(t *testing.T) {
	fixture := httpAuthFixture(t)
	acceptedAt := httpUint64(t, fixture["acceptedAt"], "accepted at")
	certificateVector := httpObject(t, fixture["certificate"], "certificate")
	encoded := decodeBase64URL(t, httpString(t, certificateVector["fullCborB64"], "certificate bytes"))
	certificate, err := pairing.VerifyActivationCertificate(encoded, pairing.VerifyActivationCertificateOptions{
		WorkerKeys: httpWorkerKeys(t, fixture), NowSeconds: acceptedAt, MinimumCredentialEpoch: 7,
	})
	if err != nil {
		t.Fatalf("verify valid activation certificate: %v", err)
	}
	if !bytes.Equal(certificate.UnsignedCBOR, decodeBase64URL(t, httpString(t, certificateVector["unsignedCborB64"], "unsigned certificate"))) {
		t.Fatal("activation certificate unsigned CBOR differs")
	}
	if !bytes.Equal(certificate.Signature, decodeBase64URL(t, httpString(t, certificateVector["signatureB64"], "certificate signature"))) {
		t.Fatal("activation certificate signature differs")
	}
	if pairing.ActivationCertificateRenewalState(certificate, acceptedAt) != "valid" || pairing.ActivationCertificateRenewalState(certificate, certificate.ExpiresAt-pairing.ActivationCertificateRenewal) != "renewal_due" || pairing.ActivationCertificateRenewalState(certificate, certificate.ExpiresAt) != "expired" {
		t.Fatal("activation certificate renewal states are not frozen")
	}

	for _, raw := range httpArray(t, fixture["certificateRejections"], "certificate rejections") {
		vector := httpObject(t, raw, "certificate rejection")
		options := httpObject(t, vector["options"], "certificate rejection options")
		keys := httpWorkerKeys(t, fixture)
		if httpString(t, options["unknownWorkerKey"], "unknown Worker key") == "true" {
			keys = map[string][]byte{}
		}
		revoked := map[string]bool{}
		if value := httpString(t, options["revokedSerialB64"], "revoked serial"); value != "" {
			revoked[value] = true
		}
		_, err := pairing.VerifyActivationCertificate(
			decodeBase64URL(t, httpString(t, vector["certificateB64"], "rejected certificate")),
			pairing.VerifyActivationCertificateOptions{
				WorkerKeys:             keys,
				NowSeconds:             httpUint64(t, options["nowSeconds"], "rejection current time"),
				MinimumCredentialEpoch: httpUint64(t, options["minimumCredentialEpoch"], "minimum credential epoch"),
				RevokedSerials:         revoked,
			},
		)
		requireControlCode(t, err, httpString(t, vector["errorCode"], "certificate rejection code"), httpString(t, vector["name"], "certificate rejection name"))
	}
}

func TestControlRequestsAndRejections(t *testing.T) {
	fixture := httpAuthFixture(t)
	acceptedAt := httpUint64(t, fixture["acceptedAt"], "accepted at")
	keys := httpWorkerKeys(t, fixture)
	requests := httpArray(t, fixture["requests"], "requests")
	for _, raw := range requests {
		vector := httpObject(t, raw, "request vector")
		result, err := pairing.VerifyControlRequest(pairing.VerifyControlRequestOptions{
			RequestClass: httpString(t, vector["requestClass"], "request class"),
			Method:       httpString(t, vector["method"], "method"), Path: httpString(t, vector["pathname"], "pathname"),
			Body:       decodeBase64URLAllowEmpty(t, httpString(t, vector["rawBodyB64"], "request body")),
			RawHeaders: httpHeaders(t, vector["rawHeaders"]), WorkerKeys: keys,
			NowSeconds: acceptedAt, HeaderBoundary: "raw",
		})
		if err != nil {
			t.Fatalf("verify request %s: %v", vector["name"], err)
		}
		if !bytes.Equal(result.SigningInput, decodeBase64URL(t, httpString(t, vector["signingInputB64"], "request signing input"))) || !bytes.Equal(result.Signature, decodeBase64URL(t, httpString(t, vector["signatureB64"], "request signature"))) || !bytes.Equal(result.RequestBindingHash, decodeBase64URL(t, httpString(t, vector["requestBindingHashB64"], "request binding"))) {
			t.Fatalf("request %s exact bytes differ", vector["name"])
		}
	}

	for _, raw := range httpArray(t, fixture["requestRejections"], "request rejections") {
		vector := httpObject(t, raw, "request rejection")
		_, err := pairing.VerifyControlRequest(pairing.VerifyControlRequestOptions{
			RequestClass: httpString(t, vector["requestClass"], "request class"),
			Method:       httpString(t, vector["method"], "method"), Path: httpString(t, vector["pathname"], "pathname"),
			Body:       decodeBase64URLAllowEmpty(t, httpString(t, vector["rawBodyB64"], "request body")),
			RawHeaders: httpHeaders(t, vector["rawHeaders"]), WorkerKeys: keys,
			NowSeconds:     httpUint64(t, vector["nowSeconds"], "rejection current time"),
			HeaderBoundary: httpString(t, vector["headerBoundary"], "header boundary"),
		})
		requireControlCode(t, err, httpString(t, vector["errorCode"], "request rejection code"), httpString(t, vector["name"], "request rejection name"))
	}

	first := httpObject(t, requests[0], "first request")
	window, err := pairing.NewControlNonceWindow(nil)
	if err != nil {
		t.Fatalf("create replay window: %v", err)
	}
	input := pairing.VerifyControlRequestOptions{
		RequestClass: httpString(t, first["requestClass"], "request class"), Method: httpString(t, first["method"], "method"),
		Path: httpString(t, first["pathname"], "pathname"), Body: decodeBase64URLAllowEmpty(t, httpString(t, first["rawBodyB64"], "body")),
		RawHeaders: httpHeaders(t, first["rawHeaders"]), WorkerKeys: keys, NowSeconds: acceptedAt, HeaderBoundary: "raw", NonceWindow: window,
	}
	if _, err := pairing.VerifyControlRequest(input); err != nil {
		t.Fatalf("first replay-window request: %v", err)
	}
	_, err = pairing.VerifyControlRequest(input)
	requireControlCode(t, err, "nonce_replay", "second replay-window request")
	snapshot := window.Snapshot()
	restored, err := pairing.NewControlNonceWindow(&snapshot)
	if err != nil || len(restored.Snapshot().Entries) != 1 {
		t.Fatalf("restore replay snapshot: %v", err)
	}
}

func TestBrowserActivationIsTheOnlyUnsignedException(t *testing.T) {
	fixture := httpAuthFixture(t)
	for _, raw := range httpArray(t, fixture["browserRequests"], "browser requests") {
		vector := httpObject(t, raw, "browser request")
		err := pairing.VerifyBrowserControlException(
			httpString(t, vector["method"], "method"),
			httpString(t, vector["pathname"], "pathname"),
			decodeBase64URLAllowEmpty(t, httpString(t, vector["rawBodyB64"], "browser body")),
			httpHeaders(t, vector["rawHeaders"]),
			"raw",
		)
		if err != nil {
			t.Fatalf("verify browser request %s: %v", vector["name"], err)
		}
	}
	for _, raw := range httpArray(t, fixture["browserRejections"], "browser rejections") {
		vector := httpObject(t, raw, "browser rejection")
		err := pairing.VerifyBrowserControlException(
			httpString(t, vector["method"], "method"),
			httpString(t, vector["pathname"], "pathname"),
			decodeBase64URLAllowEmpty(t, httpString(t, vector["rawBodyB64"], "browser body")),
			httpHeaders(t, vector["rawHeaders"]),
			"raw",
		)
		requireControlCode(t, err, httpString(t, vector["errorCode"], "browser rejection code"), httpString(t, vector["name"], "browser rejection name"))
	}
}

func TestControlResponsesAndRejections(t *testing.T) {
	fixture := httpAuthFixture(t)
	acceptedAt := httpUint64(t, fixture["acceptedAt"], "accepted at")
	keys := httpWorkerKeys(t, fixture)
	for _, raw := range httpArray(t, fixture["responses"], "responses") {
		vector := httpObject(t, raw, "response vector")
		websocketKey := ""
		if value, ok := vector["webSocketKey"]; ok {
			websocketKey = httpString(t, value, "WebSocket key")
		}
		result, err := pairing.VerifyControlResponse(pairing.VerifyControlResponseOptions{
			Path: httpString(t, vector["pathname"], "pathname"), Status: uint16(httpInt(t, vector["status"], "status")),
			Body:       decodeBase64URLAllowEmpty(t, httpString(t, vector["rawBodyB64"], "response body")),
			RawHeaders: httpHeaders(t, vector["rawHeaders"]), RequestBindingHash: decodeBase64URL(t, httpString(t, vector["requestBindingHashB64"], "request binding")),
			WorkerKeys: keys, NowSeconds: acceptedAt, HeaderBoundary: "raw", ExpectedWebSocketKey: websocketKey,
		})
		if err != nil {
			t.Fatalf("verify response %s: %v", vector["name"], err)
		}
		if !bytes.Equal(result.SigningInput, decodeBase64URL(t, httpString(t, vector["signingInputB64"], "response signing input"))) || !bytes.Equal(result.Signature, decodeBase64URL(t, httpString(t, vector["signatureB64"], "response signature"))) {
			t.Fatalf("response %s exact bytes differ", vector["name"])
		}
	}

	for _, raw := range httpArray(t, fixture["responseRejections"], "response rejections") {
		vector := httpObject(t, raw, "response rejection")
		websocketKey := ""
		if value, ok := vector["webSocketKey"]; ok {
			websocketKey = httpString(t, value, "WebSocket key")
		}
		_, err := pairing.VerifyControlResponse(pairing.VerifyControlResponseOptions{
			Path: httpString(t, vector["pathname"], "pathname"), Status: uint16(httpInt(t, vector["status"], "status")),
			Body:       decodeBase64URLAllowEmpty(t, httpString(t, vector["rawBodyB64"], "response body")),
			RawHeaders: httpHeaders(t, vector["rawHeaders"]), RequestBindingHash: decodeBase64URL(t, httpString(t, vector["requestBindingHashB64"], "request binding")),
			WorkerKeys: keys, NowSeconds: httpUint64(t, vector["nowSeconds"], "rejection current time"),
			HeaderBoundary: httpString(t, vector["headerBoundary"], "header boundary"), ExpectedWebSocketKey: websocketKey,
		})
		requireControlCode(t, err, httpString(t, vector["errorCode"], "response rejection code"), httpString(t, vector["name"], "response rejection name"))
	}
}

func decodeBase64URLAllowEmpty(t *testing.T, value string) []byte {
	t.Helper()
	if value == "" {
		return []byte{}
	}
	return decodeBase64URL(t, value)
}
