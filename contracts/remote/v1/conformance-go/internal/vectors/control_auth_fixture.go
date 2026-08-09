package vectors

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
)

const controlWorkerKeyID = "waifucave-pair-certificate-2026-01"

var (
	controlWorkerSeed       = pairing.Sequence(0x20, 32)
	controlInstallationSeed = pairing.Sequence(0x50, 32)
)

type controlRequestFixtureVector struct {
	value   map[string]any
	created *pairing.CreatedControlRequest
}

func controlBody(value map[string]any) ([]byte, error) {
	return pairing.CanonicalJSONV1(value)
}

func controlHeaders(value []pairing.HeaderTuple) []any {
	result := make([]any, len(value))
	for index, tuple := range value {
		result[index] = []any{tuple[0], tuple[1]}
	}
	return result
}

func controlRequestVector(name, class, method, path string, body, nonce, certificate []byte, websocketKey string) (*controlRequestFixtureVector, error) {
	created, err := pairing.CreateControlRequest(pairing.CreateControlRequestInput{
		RequestClass: class, Method: method, Path: path, Body: body,
		Timestamp: controlAcceptedAt, RequestNonce: nonce,
		InstallationPrivateKeySeed: controlInstallationSeed,
		CertificateBytes:           certificate, WebSocketKey: websocketKey,
	})
	if err != nil {
		return nil, err
	}
	value := map[string]any{
		"name": name, "requestClass": class, "method": method, "pathname": path,
		"rawBodyB64": pairing.B64(body), "rawHeaders": controlHeaders(created.RawHeaders),
		"normalizedAuthHeaders": created.NormalizedAuthHeaders,
		"signingInputB64":       pairing.B64(created.SigningInput), "signatureB64": pairing.B64(created.Signature),
		"requestBindingHashB64": pairing.B64(created.RequestBindingHash),
	}
	if websocketKey != "" {
		value["webSocketKey"] = websocketKey
	}
	return &controlRequestFixtureVector{value: value, created: created}, nil
}

func controlClone(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			result[key] = controlClone(item)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = controlClone(item)
		}
		return result
	case []byte:
		return append([]byte(nil), typed...)
	default:
		return value
	}
}

func httpAuthCloneMap(value map[string]any) map[string]any {
	return controlClone(value).(map[string]any)
}

func controlHeaderTuples(value map[string]any) []any {
	return value["rawHeaders"].([]any)
}

func controlHeaderIndex(value map[string]any, name string) int {
	for index, raw := range controlHeaderTuples(value) {
		tuple := raw.([]any)
		candidate := tuple[0].(string)
		if bytes.EqualFold([]byte(candidate), []byte(name)) {
			return index
		}
	}
	return -1
}

func controlSetHeader(value map[string]any, name, headerValue string) {
	index := controlHeaderIndex(value, name)
	if index < 0 {
		controlAppendHeader(value, "x-waifus-fixture-error", "missing-"+name)
		return
	}
	tuple := controlHeaderTuples(value)[index].([]any)
	tuple[1] = headerValue
}

func controlRemoveHeader(value map[string]any, name string) {
	headers := controlHeaderTuples(value)
	index := controlHeaderIndex(value, name)
	if index < 0 {
		controlAppendHeader(value, "x-waifus-fixture-error", "missing-"+name)
		return
	}
	value["rawHeaders"] = append(headers[:index], headers[index+1:]...)
}

func controlAppendHeader(value map[string]any, name, headerValue string) {
	value["rawHeaders"] = append(controlHeaderTuples(value), []any{name, headerValue})
}

func httpAuthMutateB64(value string) string {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) == 0 {
		return ""
	}
	decoded[0] ^= 1
	return pairing.B64(decoded)
}

func controlHeaderValue(value map[string]any, name string) string {
	index := controlHeaderIndex(value, name)
	if index < 0 {
		return ""
	}
	tuple, ok := controlHeaderTuples(value)[index].([]any)
	if !ok || len(tuple) != 2 {
		return ""
	}
	text, _ := tuple[1].(string)
	return text
}

func controlRequestRejection(name string, source map[string]any, code string, mutate func(map[string]any)) map[string]any {
	value := httpAuthCloneMap(source)
	if mutate != nil {
		mutate(value)
	}
	now, ok := value["nowSeconds"]
	if !ok {
		now = fmt.Sprintf("%d", controlAcceptedAt)
	}
	boundary, ok := value["headerBoundary"]
	if !ok {
		boundary = "raw"
	}
	return map[string]any{
		"name": name, "requestClass": value["requestClass"], "method": value["method"],
		"pathname": value["pathname"], "rawBodyB64": value["rawBodyB64"], "rawHeaders": value["rawHeaders"],
		"nowSeconds": now, "headerBoundary": boundary, "errorCode": code,
	}
}

func controlCertificateMap(encoded []byte) map[uint64]any {
	decoded, err := pairing.DecodeCanonicalCBOR(encoded)
	if err != nil {
		return map[uint64]any{}
	}
	value, ok := decoded.(map[uint64]any)
	if !ok {
		return map[uint64]any{}
	}
	result := make(map[uint64]any, len(value))
	for key, item := range value {
		if raw, ok := item.([]byte); ok {
			result[key] = append([]byte(nil), raw...)
		} else {
			result[key] = item
		}
	}
	return result
}

func controlCertificateRejection(name string, certificate []byte, code string, now, minimum uint64, unknown bool, revoked string) map[string]any {
	return map[string]any{
		"name": name, "certificateB64": pairing.B64(certificate), "errorCode": code,
		"options": map[string]any{
			"nowSeconds": fmt.Sprintf("%d", now), "minimumCredentialEpoch": fmt.Sprintf("%d", minimum),
			"unknownWorkerKey": map[bool]string{true: "true", false: "false"}[unknown],
			"revokedSerialB64": revoked,
		},
	}
}

func controlResponseVector(name string, request *controlRequestFixtureVector, status uint16, body, nonce []byte, websocketKey string) (map[string]any, error) {
	created, err := pairing.CreateControlResponse(pairing.CreateControlResponseInput{
		Path: request.value["pathname"].(string), Status: status, Body: body,
		ProtocolMajor: 1, ProtocolMinor: 0, WorkerSigningKeyID: controlWorkerKeyID,
		Timestamp: controlAcceptedAt, ResponseNonce: nonce,
		RequestBindingHash:   request.created.RequestBindingHash,
		WorkerPrivateKeySeed: controlWorkerSeed, WebSocketKey: websocketKey,
	})
	if err != nil {
		return nil, err
	}
	value := map[string]any{
		"name": name, "pathname": request.value["pathname"], "status": int(status),
		"rawBodyB64": pairing.B64(body), "rawHeaders": controlHeaders(created.RawHeaders),
		"normalizedAuthHeaders": created.NormalizedAuthHeaders,
		"requestBindingHashB64": pairing.B64(request.created.RequestBindingHash),
		"signingInputB64":       pairing.B64(created.SigningInput), "signatureB64": pairing.B64(created.Signature),
	}
	if websocketKey != "" {
		value["webSocketKey"] = websocketKey
	}
	return value, nil
}

func controlResponseRejection(name string, source map[string]any, code string, mutate func(map[string]any)) map[string]any {
	value := httpAuthCloneMap(source)
	if mutate != nil {
		mutate(value)
	}
	value["name"] = name
	if _, ok := value["nowSeconds"]; !ok {
		value["nowSeconds"] = fmt.Sprintf("%d", controlAcceptedAt)
	}
	if _, ok := value["headerBoundary"]; !ok {
		value["headerBoundary"] = "raw"
	}
	value["errorCode"] = code
	return value
}

func controlBrowserRejection(name string, source map[string]any, code string, mutate func(map[string]any)) map[string]any {
	value := httpAuthCloneMap(source)
	if mutate != nil {
		mutate(value)
	}
	value["name"] = name
	value["errorCode"] = code
	return value
}

func controlLPFixture(value []byte) []byte {
	length := make([]byte, 4)
	binary.BigEndian.PutUint32(length, uint32(len(value)))
	return append(length, value...)
}

func BuildHttpAuthEnvelopeV1() (map[string]any, error) {
	workerPublic := ed25519.NewKeyFromSeed(controlWorkerSeed).Public().(ed25519.PublicKey)
	installationPublic := ed25519.NewKeyFromSeed(controlInstallationSeed).Public().(ed25519.PublicKey)
	issuedAt := controlAcceptedAt - 86400
	expiresAt := issuedAt + pairing.ActivationCertificateLifetime
	certificateValue := pairing.ActivationCertificateUnsigned{
		Version: 1, Serial: pairing.Sequence(0x10, 16), InstallationPublicKey: installationPublic,
		IssuedAt: issuedAt, ExpiresAt: expiresAt, CredentialEpoch: 7,
		CoordinationMajor: 1, CoordinationMinor: 0, QuotaTier: 1, WorkerSigningKeyID: controlWorkerKeyID,
	}
	certificate, err := pairing.CreateActivationCertificate(controlWorkerSeed, certificateValue)
	if err != nil {
		return nil, err
	}
	invitationID := pairing.B64(pairing.Sequence(0x80, 16))
	pairID := pairing.B64(pairing.Sequence(0x90, 16))
	activationID := pairing.B64(pairing.Sequence(0xa0, 32))
	helperNonce := pairing.B64(pairing.Sequence(0xc0, 32))
	websocketKey := base64.StdEncoding.EncodeToString(pairing.Sequence(0xe0, 16))

	identityHash := sha256.Sum256([]byte("remote-identity"))
	ordinaryBody, err := controlBody(map[string]any{
		"identityCommitment": pairing.B64(identityHash[:]), "protocolMajor": 1, "protocolMinor": 0,
	})
	if err != nil {
		return nil, err
	}
	activationBody, err := controlBody(map[string]any{"activationId": activationID, "helperNonce": helperNonce})
	if err != nil {
		return nil, err
	}
	ordinary, err := controlRequestVector("certificate-request", "certificate", "POST", "/v1/invitations/"+invitationID+"/claim", ordinaryBody, pairing.Sequence(0x01, 16), certificate.EncodedCBOR, "")
	if err != nil {
		return nil, err
	}
	begin, err := controlRequestVector("activation-begin", "activation_begin", "POST", "/v1/activation/challenges", activationBody, pairing.Sequence(0x02, 16), certificate.EncodedCBOR, "")
	if err != nil {
		return nil, err
	}
	poll, err := controlRequestVector("activation-poll", "activation_poll", "POST", "/v1/activation/poll", activationBody, pairing.Sequence(0x03, 16), certificate.EncodedCBOR, "")
	if err != nil {
		return nil, err
	}
	websocket, err := controlRequestVector("websocket-upgrade", "websocket", "GET", "/v1/pairs/"+pairID+"/control", []byte{}, pairing.Sequence(0x04, 16), certificate.EncodedCBOR, websocketKey)
	if err != nil {
		return nil, err
	}
	requests := []any{ordinary.value, begin.value, poll.value, websocket.value}

	successBody, err := controlBody(map[string]any{"invitationGeneration": "1", "pairId": pairID})
	if err != nil {
		return nil, err
	}
	errorBody, err := controlBody(map[string]any{"error": "challenge_exists", "message": "Activation challenge already exists."})
	if err != nil {
		return nil, err
	}
	success, err := controlResponseVector("signed-success", ordinary, 201, successBody, pairing.Sequence(0x31, 16), "")
	if err != nil {
		return nil, err
	}
	safeError, err := controlResponseVector("signed-safe-error", begin, 409, errorBody, pairing.Sequence(0x41, 16), "")
	if err != nil {
		return nil, err
	}
	websocketResponse, err := controlResponseVector("signed-websocket-101", websocket, 101, []byte{}, pairing.Sequence(0x51, 16), websocketKey)
	if err != nil {
		return nil, err
	}
	responses := []any{success, safeError, websocketResponse}
	browserCompletionBody, err := controlBody(map[string]any{
		"activationId":   activationID,
		"browserNonce":   pairing.B64(pairing.Sequence(0x70, 32)),
		"turnstileToken": "turnstile-fixture-token",
	})
	if err != nil {
		return nil, err
	}
	activationDocument := map[string]any{
		"name": "activation-document", "method": "GET", "pathname": "/activate",
		"rawBodyB64": "", "rawHeaders": []any{[]any{"accept", "text/html"}},
	}
	activationCompletion := map[string]any{
		"name": "activation-completion", "method": "POST", "pathname": "/v1/activation/complete",
		"rawBodyB64": pairing.B64(browserCompletionBody),
		"rawHeaders": []any{[]any{"content-type", "application/json"}},
	}
	browserRequests := []any{activationDocument, activationCompletion}
	browserRejections := []any{
		controlBrowserRejection("activation-document-auth-header", activationDocument, "forbidden_header", func(value map[string]any) {
			value["rawHeaders"] = []any{[]any{"x-waifus-protocol", "1.0"}}
		}),
		controlBrowserRejection("activation-completion-auth-header", activationCompletion, "forbidden_header", func(value map[string]any) {
			value["rawHeaders"] = []any{[]any{"content-type", "application/json"}, []any{"x-waifus-protocol", "1.0"}}
		}),
		controlBrowserRejection("activation-document-body", activationDocument, "invalid_request", func(value map[string]any) {
			value["rawBodyB64"] = pairing.B64([]byte("{}"))
		}),
		controlBrowserRejection("activation-completion-content-type", activationCompletion, "invalid_request", func(value map[string]any) {
			value["rawHeaders"] = []any{[]any{"content-type", "text/plain"}}
		}),
		controlBrowserRejection("activation-completion-over-limit", activationCompletion, "invalid_request", func(value map[string]any) {
			value["rawBodyB64"] = pairing.B64(bytes.Repeat([]byte{'a'}, 4097))
		}),
		controlBrowserRejection("activation-completion-wrong-route", activationCompletion, "invalid_request", func(value map[string]any) {
			value["pathname"] = "/v1/activation/challenges"
		}),
	}

	wrongSignatureMap := controlCertificateMap(certificate.EncodedCBOR)
	fixtureSignature, ok := wrongSignatureMap[11].([]byte)
	if !ok || len(fixtureSignature) != ed25519.SignatureSize {
		return nil, fmt.Errorf("generated certificate is missing its signature")
	}
	wrongSignature := append([]byte(nil), fixtureSignature...)
	wrongSignature[0] ^= 1
	wrongSignatureMap[11] = wrongSignature
	wrongSignatureCBOR, err := pairing.EncodeCanonicalCBOR(wrongSignatureMap)
	if err != nil {
		return nil, err
	}
	wrongWidthMap := controlCertificateMap(certificate.EncodedCBOR)
	wrongWidthMap[2] = pairing.Sequence(0x10, 15)
	wrongWidthCBOR, err := pairing.EncodeCanonicalCBOR(wrongWidthMap)
	if err != nil {
		return nil, err
	}
	wrongLifetimeMap := controlCertificateMap(certificate.EncodedCBOR)
	wrongLifetimeMap[5] = expiresAt + 1
	wrongLifetimeCBOR, err := pairing.EncodeCanonicalCBOR(wrongLifetimeMap)
	if err != nil {
		return nil, err
	}
	unknownFieldMap := controlCertificateMap(certificate.EncodedCBOR)
	unknownFieldMap[12] = uint64(1)
	unknownFieldCBOR, err := pairing.EncodeCanonicalCBOR(unknownFieldMap)
	if err != nil {
		return nil, err
	}
	certificateRejections := []any{
		controlCertificateRejection("trailing-cbor-byte", append(append([]byte(nil), certificate.EncodedCBOR...), 0), "invalid_certificate", controlAcceptedAt, 7, false, ""),
		controlCertificateRejection("wrong-certificate-signature", wrongSignatureCBOR, "invalid_certificate_signature", controlAcceptedAt, 7, false, ""),
		controlCertificateRejection("wrong-serial-width", wrongWidthCBOR, "invalid_certificate", controlAcceptedAt, 7, false, ""),
		controlCertificateRejection("wrong-certificate-lifetime", wrongLifetimeCBOR, "certificate_lifetime", controlAcceptedAt, 7, false, ""),
		controlCertificateRejection("unknown-certificate-field", unknownFieldCBOR, "invalid_certificate", controlAcceptedAt, 7, false, ""),
	}
	certificateSubstitutions := []struct {
		name  string
		code  string
		apply func(map[uint64]any)
	}{
		{"certificate-version-substitution", "invalid_certificate", func(value map[uint64]any) { value[1] = uint64(2) }},
		{"certificate-serial-substitution", "invalid_certificate_signature", func(value map[uint64]any) { value[2] = pairing.Sequence(0x11, 16) }},
		{"certificate-installation-key-substitution", "invalid_certificate_signature", func(value map[uint64]any) { value[3] = pairing.Sequence(0x51, 32) }},
		{"certificate-time-substitution", "invalid_certificate_signature", func(value map[uint64]any) { value[4], value[5] = issuedAt+1, expiresAt+1 }},
		{"certificate-epoch-substitution", "invalid_certificate_signature", func(value map[uint64]any) { value[6] = uint64(8) }},
		{"certificate-major-substitution", "invalid_certificate", func(value map[uint64]any) { value[7] = uint64(2) }},
		{"certificate-minor-substitution", "invalid_certificate", func(value map[uint64]any) { value[8] = uint64(1) }},
		{"certificate-quota-substitution", "invalid_certificate", func(value map[uint64]any) { value[9] = uint64(2) }},
		{"certificate-key-id-substitution", "unknown_worker_key", func(value map[uint64]any) { value[10] = "waifucave-pair-staging-certificate-2026-01" }},
	}
	for _, substitution := range certificateSubstitutions {
		candidate := controlCertificateMap(certificate.EncodedCBOR)
		substitution.apply(candidate)
		encoded, encodeErr := pairing.EncodeCanonicalCBOR(candidate)
		if encodeErr != nil {
			return nil, encodeErr
		}
		certificateRejections = append(certificateRejections, controlCertificateRejection(
			substitution.name, encoded, substitution.code, controlAcceptedAt, 7, false, "",
		))
	}
	certificateRejections = append(certificateRejections,
		controlCertificateRejection("unknown-worker-key", certificate.EncodedCBOR, "unknown_worker_key", controlAcceptedAt, 7, true, ""),
		controlCertificateRejection("certificate-not-yet-valid", certificate.EncodedCBOR, "certificate_not_yet_valid", issuedAt-1, 7, false, ""),
		controlCertificateRejection("certificate-expired", certificate.EncodedCBOR, "certificate_expired", expiresAt, 7, false, ""),
		controlCertificateRejection("credential-epoch-rollback", certificate.EncodedCBOR, "credential_epoch_rollback", controlAcceptedAt, 8, false, ""),
		controlCertificateRejection("revoked-serial", certificate.EncodedCBOR, "certificate_revoked", controlAcceptedAt, 7, false, pairing.B64(certificate.Serial)),
	)

	ordinarySource := ordinary.value
	beginSource := begin.value
	websocketSource := websocket.value
	requestRejections := []any{
		controlRequestRejection("method-substitution", ordinarySource, "invalid_signature", func(value map[string]any) { value["method"] = "PUT" }),
		controlRequestRejection("concrete-path-substitution", ordinarySource, "invalid_signature", func(value map[string]any) {
			value["pathname"] = "/v1/invitations/" + pairing.B64(pairing.Sequence(0x81, 16)) + "/claim"
		}),
		controlRequestRejection("route-template-replay", ordinarySource, "invalid_signature", func(value map[string]any) { value["pathname"] = "/v1/invitations/:invitationId/claim" }),
		controlRequestRejection("query-bearing-path", ordinarySource, "invalid_request", func(value map[string]any) { value["pathname"] = value["pathname"].(string) + "?invitationId=alias" }),
		controlRequestRejection("percent-encoded-alias", ordinarySource, "invalid_request", func(value map[string]any) { value["pathname"] = "/v1/invitations/%67/claim" }),
		controlRequestRejection("body-byte-substitution", ordinarySource, "invalid_signature", func(value map[string]any) {
			decoded, _ := base64.RawURLEncoding.DecodeString(value["rawBodyB64"].(string))
			value["rawBodyB64"] = pairing.B64(append(decoded, ' '))
		}),
		controlRequestRejection("protocol-substitution", ordinarySource, "invalid_header_value", func(value map[string]any) { controlSetHeader(value, "x-waifus-protocol", "1.1") }),
		controlRequestRejection("missing-request-signature", ordinarySource, "missing_header", func(value map[string]any) { controlRemoveHeader(value, "x-waifus-request-signature") }),
		controlRequestRejection("unknown-auth-header", ordinarySource, "unknown_auth_header", func(value map[string]any) { controlAppendHeader(value, "x-waifus-extra", "value") }),
		controlRequestRejection("raw-uppercase-application-name", ordinarySource, "invalid_header_name", func(value map[string]any) { controlHeaderTuples(value)[0].([]any)[0] = "X-Waifus-Protocol" }),
		controlRequestRejection("exact-duplicate", ordinarySource, "duplicate_header", func(value map[string]any) { controlAppendHeader(value, "x-waifus-protocol", "1.0") }),
		controlRequestRejection("mixed-case-duplicate", ordinarySource, "duplicate_header", func(value map[string]any) { controlAppendHeader(value, "X-Waifus-Protocol", "1.0") }),
		controlRequestRejection("platform-comma-coalescing", ordinarySource, "invalid_header_value", func(value map[string]any) { controlSetHeader(value, "x-waifus-protocol", "1.0,1.0") }),
		controlRequestRejection("leading-header-whitespace", ordinarySource, "invalid_header_value", func(value map[string]any) { controlSetHeader(value, "x-waifus-protocol", " 1.0") }),
		controlRequestRejection("header-tab", ordinarySource, "invalid_header_value", func(value map[string]any) { controlSetHeader(value, "x-waifus-protocol", "1.0\t") }),
		controlRequestRejection("padded-request-nonce", ordinarySource, "invalid_header_value", func(value map[string]any) {
			controlSetHeader(value, "x-waifus-request-nonce", controlHeaderValue(value, "x-waifus-request-nonce")+"=")
		}),
		controlRequestRejection("wrong-request-nonce-width", ordinarySource, "invalid_header_value", func(value map[string]any) {
			controlSetHeader(value, "x-waifus-request-nonce", pairing.B64(bytes.Repeat([]byte{1}, 15)))
		}),
		controlRequestRejection("leading-zero-timestamp", ordinarySource, "invalid_header_value", func(value map[string]any) {
			controlSetHeader(value, "x-waifus-timestamp", "0"+fmt.Sprintf("%d", controlAcceptedAt))
		}),
		controlRequestRejection("overflow-timestamp", ordinarySource, "invalid_header_value", func(value map[string]any) { controlSetHeader(value, "x-waifus-timestamp", "18446744073709551616") }),
		controlRequestRejection("request-timestamp-substitution", ordinarySource, "invalid_signature", func(value map[string]any) {
			controlSetHeader(value, "x-waifus-timestamp", fmt.Sprintf("%d", controlAcceptedAt+1))
		}),
		controlRequestRejection("request-nonce-substitution", ordinarySource, "invalid_signature", func(value map[string]any) {
			controlSetHeader(value, "x-waifus-request-nonce", httpAuthMutateB64(controlHeaderValue(value, "x-waifus-request-nonce")))
		}),
		controlRequestRejection("aggregate-auth-header-limit", ordinarySource, "header_limit", func(value map[string]any) {
			controlSetHeader(value, "x-waifus-certificate", string(bytes.Repeat([]byte{'A'}, 904)))
		}),
		controlRequestRejection("response-header-on-request", ordinarySource, "forbidden_header", func(value map[string]any) { controlAppendHeader(value, "x-waifus-worker-key-id", controlWorkerKeyID) }),
		controlRequestRejection("installation-header-on-certificate-request", ordinarySource, "forbidden_header", func(value map[string]any) {
			controlAppendHeader(value, "x-waifus-installation-key", pairing.B64(installationPublic))
		}),
		controlRequestRejection("certificate-header-on-precertificate-request", beginSource, "forbidden_header", func(value map[string]any) {
			controlAppendHeader(value, "x-waifus-certificate", pairing.B64(certificate.EncodedCBOR))
		}),
		controlRequestRejection("stale-request-timestamp", ordinarySource, "timestamp_out_of_window", func(value map[string]any) { value["nowSeconds"] = fmt.Sprintf("%d", controlAcceptedAt+61) }),
		controlRequestRejection("future-request-timestamp", ordinarySource, "timestamp_out_of_window", func(value map[string]any) { value["nowSeconds"] = fmt.Sprintf("%d", controlAcceptedAt-61) }),
		controlRequestRejection("wrong-request-signature", ordinarySource, "invalid_signature", func(value map[string]any) {
			controlSetHeader(value, "x-waifus-request-signature", httpAuthMutateB64(controlHeaderValue(value, "x-waifus-request-signature")))
		}),
		controlRequestRejection("websocket-body", websocketSource, "invalid_websocket", func(value map[string]any) { value["rawBodyB64"] = pairing.B64([]byte("{}")) }),
		controlRequestRejection("websocket-extension", websocketSource, "invalid_websocket", func(value map[string]any) {
			controlAppendHeader(value, "sec-websocket-extensions", "permessage-deflate")
		}),
		controlRequestRejection("websocket-subprotocol", websocketSource, "invalid_websocket", func(value map[string]any) { controlSetHeader(value, "sec-websocket-protocol", "other") }),
		controlRequestRejection("websocket-content-type", websocketSource, "invalid_websocket", func(value map[string]any) { controlAppendHeader(value, "content-type", "application/json") }),
		controlRequestRejection("websocket-key-width", websocketSource, "invalid_websocket", func(value map[string]any) {
			controlSetHeader(value, "sec-websocket-key", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0}, 15)))
		}),
		controlRequestRejection("request-body-over-limit", ordinarySource, "invalid_request", func(value map[string]any) { value["rawBodyB64"] = pairing.B64(bytes.Repeat([]byte{'a'}, 2049)) }),
	}

	responseRejections := []any{
		controlResponseRejection("response-path-substitution", success, "invalid_signature", func(value map[string]any) {
			value["pathname"] = "/v1/invitations/" + pairing.B64(pairing.Sequence(0x81, 16)) + "/claim"
		}),
		controlResponseRejection("response-status-substitution", success, "invalid_signature", func(value map[string]any) { value["status"] = 200 }),
		controlResponseRejection("response-body-substitution", success, "invalid_signature", func(value map[string]any) {
			decoded, _ := base64.RawURLEncoding.DecodeString(value["rawBodyB64"].(string))
			value["rawBodyB64"] = pairing.B64(append(decoded, ' '))
		}),
		controlResponseRejection("response-request-binding-substitution", success, "invalid_signature", func(value map[string]any) {
			value["requestBindingHashB64"] = httpAuthMutateB64(value["requestBindingHashB64"].(string))
		}),
		controlResponseRejection("response-protocol-substitution", success, "invalid_header_value", func(value map[string]any) { controlSetHeader(value, "x-waifus-protocol", "1.1") }),
		controlResponseRejection("unknown-response-worker-key", success, "unknown_worker_key", func(value map[string]any) {
			controlSetHeader(value, "x-waifus-worker-key-id", "waifucave-pair-certificate-2099-01")
		}),
		controlResponseRejection("stale-response", success, "timestamp_out_of_window", func(value map[string]any) { value["nowSeconds"] = fmt.Sprintf("%d", controlAcceptedAt+61) }),
		controlResponseRejection("wrong-response-nonce-width", success, "invalid_header_value", func(value map[string]any) {
			controlSetHeader(value, "x-waifus-response-nonce", pairing.B64(bytes.Repeat([]byte{1}, 15)))
		}),
		controlResponseRejection("response-timestamp-substitution", success, "invalid_signature", func(value map[string]any) {
			controlSetHeader(value, "x-waifus-timestamp", fmt.Sprintf("%d", controlAcceptedAt+1))
		}),
		controlResponseRejection("response-nonce-substitution", success, "invalid_signature", func(value map[string]any) {
			controlSetHeader(value, "x-waifus-response-nonce", httpAuthMutateB64(controlHeaderValue(value, "x-waifus-response-nonce")))
		}),
		controlResponseRejection("wrong-response-signature", success, "invalid_signature", func(value map[string]any) {
			controlSetHeader(value, "x-waifus-response-signature", httpAuthMutateB64(controlHeaderValue(value, "x-waifus-response-signature")))
		}),
		controlResponseRejection("missing-response-signature", success, "missing_header", func(value map[string]any) { controlRemoveHeader(value, "x-waifus-response-signature") }),
		controlResponseRejection("request-header-on-response", success, "forbidden_header", func(value map[string]any) {
			controlAppendHeader(value, "x-waifus-request-nonce", pairing.B64(pairing.Sequence(0x01, 16)))
		}),
		controlResponseRejection("response-content-type-drift", success, "invalid_response", func(value map[string]any) { controlSetHeader(value, "content-type", "application/json; charset=utf-8") }),
		controlResponseRejection("raw-uppercase-response-name", success, "invalid_header_name", func(value map[string]any) { controlHeaderTuples(value)[0].([]any)[0] = "X-Waifus-Protocol" }),
		controlResponseRejection("duplicate-response-header", success, "duplicate_header", func(value map[string]any) { controlAppendHeader(value, "x-waifus-protocol", "1.0") }),
		controlResponseRejection("websocket-accept-substitution", websocketResponse, "invalid_websocket", func(value map[string]any) {
			controlSetHeader(value, "sec-websocket-accept", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 20)))
		}),
		controlResponseRejection("websocket-response-subprotocol", websocketResponse, "invalid_websocket", func(value map[string]any) { controlSetHeader(value, "sec-websocket-protocol", "other") }),
		controlResponseRejection("websocket-response-extension", websocketResponse, "invalid_websocket", func(value map[string]any) {
			controlAppendHeader(value, "sec-websocket-extensions", "permessage-deflate")
		}),
		controlResponseRejection("websocket-response-body", websocketResponse, "invalid_websocket", func(value map[string]any) { value["rawBodyB64"] = pairing.B64([]byte("{}")) }),
		controlResponseRejection("response-body-over-limit", success, "invalid_response", func(value map[string]any) { value["rawBodyB64"] = pairing.B64(bytes.Repeat([]byte{'a'}, 2049)) }),
	}

	certificateInput, err := pairing.ActivationCertificateSignatureInput(certificateValue)
	if err != nil {
		return nil, err
	}
	invalidLifetimeUnsigned := controlCertificateMap(certificate.EncodedCBOR)
	delete(invalidLifetimeUnsigned, 11)
	invalidLifetimeUnsigned[5] = expiresAt + 1
	invalidLifetimeCBOR, err := pairing.EncodeCanonicalCBOR(invalidLifetimeUnsigned)
	if err != nil {
		return nil, err
	}
	invalidLifetimeInput := append(controlLPFixture([]byte("waifus/activation-certificate/v1")), controlLPFixture(invalidLifetimeCBOR)...)

	return map[string]any{
		"version": 1, "acceptedAt": fmt.Sprintf("%d", controlAcceptedAt),
		"protocol":     map[string]any{"major": 1, "minor": 0},
		"worker":       map[string]any{"keyId": controlWorkerKeyID, "privateSeedB64": pairing.B64(controlWorkerSeed), "publicKeyB64": pairing.B64(workerPublic)},
		"installation": map[string]any{"privateSeedB64": pairing.B64(controlInstallationSeed), "publicKeyB64": pairing.B64(installationPublic)},
		"certificate": map[string]any{
			"value": map[string]any{
				"version": 1, "serialB64": pairing.B64(certificate.Serial), "installationPublicKeyB64": pairing.B64(certificate.InstallationPublicKey),
				"issuedAt": fmt.Sprintf("%d", certificate.IssuedAt), "expiresAt": fmt.Sprintf("%d", certificate.ExpiresAt),
				"credentialEpoch": fmt.Sprintf("%d", certificate.CredentialEpoch), "coordinationMajor": int(certificate.CoordinationMajor),
				"coordinationMinor": int(certificate.CoordinationMinor), "quotaTier": int(certificate.QuotaTier), "workerSigningKeyId": certificate.WorkerSigningKeyID,
			},
			"unsignedCborB64": pairing.B64(certificate.UnsignedCBOR), "signatureInputB64": pairing.B64(certificateInput),
			"signatureB64": pairing.B64(certificate.Signature), "fullCborB64": pairing.B64(certificate.EncodedCBOR),
			"certificateSha256B64":           pairing.B64(pairing.Hash(certificate.EncodedCBOR)),
			"invalidLifetimeSigningInputB64": pairing.B64(invalidLifetimeInput),
		},
		"requests": requests, "responses": responses,
		"browserRequests": browserRequests, "browserRejections": browserRejections,
		"certificateRejections": certificateRejections, "requestRejections": requestRejections, "responseRejections": responseRejections,
		"limits": map[string]any{
			"certificateDecodedBytes": 384, "certificateHeaderCharacters": 512,
			"aggregateAuthHeaderValueBytes": 1024, "rawBodyBytes": 2048, "turnstileCompletionRawBodyBytes": 4096,
			"timestampSkewSeconds": "60", "nonceRetentionSeconds": "600", "nonceEntries": 1024,
		},
	}, nil
}

func BuildHttpAuthEnvelopeV1JSON() ([]byte, error) {
	value, err := BuildHttpAuthEnvelopeV1()
	if err != nil {
		return nil, err
	}
	return pairing.CanonicalJSONV1(value)
}

func DecodeHttpAuthEnvelopeFixture(encoded []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}
