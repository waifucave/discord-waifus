package pairing

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
)

const (
	ActivationCertificateMaxBytes          = 384
	ControlAuthHeaderValuesMaxBytes        = 1024
	ControlBodyMaxBytes                    = 2048
	TurnstileCompletionBodyMaxBytes        = 4096
	ControlTimestampSkewSeconds     uint64 = 60
	ControlNonceRetentionSeconds    uint64 = 600
	ControlNonceMaxEntries                 = 1024
	ActivationCertificateLifetime   uint64 = 365 * 24 * 60 * 60
	ActivationCertificateRenewal    uint64 = 30 * 24 * 60 * 60
)

const (
	activationCertificateDomain = "waifus/activation-certificate/v1"
	controlRequestDomain        = "waifus/control-request/v1"
	activationBeginDomain       = "waifus/activation-begin/v1"
	activationPollDomain        = "waifus/activation-poll/v1"
	controlResponseDomain       = "waifus/control-response/v1"
	webSocketGUID               = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
)

const (
	protocolHeader          = "x-waifus-protocol"
	certificateHeader       = "x-waifus-certificate"
	installationKeyHeader   = "x-waifus-installation-key"
	timestampHeader         = "x-waifus-timestamp"
	requestNonceHeader      = "x-waifus-request-nonce"
	requestSignatureHeader  = "x-waifus-request-signature"
	workerKeyIDHeader       = "x-waifus-worker-key-id"
	responseNonceHeader     = "x-waifus-response-nonce"
	responseSignatureHeader = "x-waifus-response-signature"
)

var (
	controlWorkerKeyIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	controlMethodPattern      = regexp.MustCompile(`^[A-Z]+$`)
	controlDecimalPattern     = regexp.MustCompile(`^(?:0|[1-9][0-9]{0,19})$`)
	controlB64Pattern         = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	controlHeaderNamePattern  = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
	controlNonceIdentity      = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)
)

type ControlAuthError struct {
	Code   string
	Detail string
}

func (e *ControlAuthError) Error() string {
	return e.Code + ": " + e.Detail
}

func controlAuthFailure(code, detail string) error {
	return &ControlAuthError{Code: code, Detail: detail}
}

func ControlAuthErrorCode(err error) string {
	if value, ok := err.(*ControlAuthError); ok {
		return value.Code
	}
	return ""
}

func controlFixedBytes(value []byte, length int, name, code string) ([]byte, error) {
	if len(value) != length {
		return nil, controlAuthFailure(code, fmt.Sprintf("%s must be exactly %d bytes", name, length))
	}
	return append([]byte(nil), value...), nil
}

func controlUint16(value uint16) []byte {
	encoded := make([]byte, 2)
	binary.BigEndian.PutUint16(encoded, value)
	return encoded
}

func controlUint64(value uint64) []byte {
	encoded := make([]byte, 8)
	binary.BigEndian.PutUint64(encoded, value)
	return encoded
}

func controlProtocolBytes(major, minor uint16) []byte {
	return append(controlUint16(major), controlUint16(minor)...)
}

func controlLP(value []byte) []byte {
	length := make([]byte, 4)
	binary.BigEndian.PutUint32(length, uint32(len(value)))
	return append(length, value...)
}

func controlJoinLP(values ...[]byte) []byte {
	var output []byte
	for _, value := range values {
		output = append(output, controlLP(value)...)
	}
	return output
}

func controlHash(value []byte) []byte {
	hash := sha256.Sum256(value)
	return hash[:]
}

func validWorkerKeyID(value string) bool {
	return len(value) >= 1 && len(value) <= 64 && controlWorkerKeyIDPattern.MatchString(value)
}

type ActivationCertificateUnsigned struct {
	Version               uint64
	Serial                []byte
	InstallationPublicKey []byte
	IssuedAt              uint64
	ExpiresAt             uint64
	CredentialEpoch       uint64
	CoordinationMajor     uint16
	CoordinationMinor     uint16
	QuotaTier             uint64
	WorkerSigningKeyID    string
}

type ActivationCertificate struct {
	ActivationCertificateUnsigned
	Signature    []byte
	UnsignedCBOR []byte
	EncodedCBOR  []byte
}

func validateActivationCertificateUnsigned(value ActivationCertificateUnsigned) error {
	if value.Version != 1 || value.QuotaTier != 1 {
		return controlAuthFailure("invalid_certificate", "certificate version and free quota tier must be V1")
	}
	if len(value.Serial) != 16 || len(value.InstallationPublicKey) != 32 {
		return controlAuthFailure("invalid_certificate", "certificate serial or installation key width is invalid")
	}
	if value.CredentialEpoch == 0 || value.ExpiresAt <= value.IssuedAt {
		return controlAuthFailure("invalid_certificate", "certificate epoch or time range is invalid")
	}
	if value.ExpiresAt-value.IssuedAt != ActivationCertificateLifetime {
		return controlAuthFailure("certificate_lifetime", "activation certificate lifetime must be exactly 365 days")
	}
	if !validWorkerKeyID(value.WorkerSigningKeyID) {
		return controlAuthFailure("invalid_certificate", "Worker signing-key ID is not canonical")
	}
	if value.CoordinationMajor != 1 || value.CoordinationMinor != 0 {
		return controlAuthFailure("invalid_certificate", "V1 certificate coordination protocol must be exactly 1.0")
	}
	return nil
}

func activationCertificateUnsignedMap(value ActivationCertificateUnsigned) (map[uint64]any, error) {
	if err := validateActivationCertificateUnsigned(value); err != nil {
		return nil, err
	}
	return map[uint64]any{
		1: uint64(1), 2: append([]byte(nil), value.Serial...),
		3: append([]byte(nil), value.InstallationPublicKey...),
		4: value.IssuedAt, 5: value.ExpiresAt, 6: value.CredentialEpoch,
		7: uint64(value.CoordinationMajor), 8: uint64(value.CoordinationMinor),
		9: uint64(1), 10: value.WorkerSigningKeyID,
	}, nil
}

func EncodeActivationCertificateUnsigned(value ActivationCertificateUnsigned) ([]byte, error) {
	fields, err := activationCertificateUnsignedMap(value)
	if err != nil {
		return nil, err
	}
	return EncodeCanonicalCBOR(fields)
}

func ActivationCertificateSignatureInput(value ActivationCertificateUnsigned) ([]byte, error) {
	unsigned, err := EncodeActivationCertificateUnsigned(value)
	if err != nil {
		return nil, err
	}
	return controlJoinLP([]byte(activationCertificateDomain), unsigned), nil
}

func CreateActivationCertificate(workerSeed []byte, value ActivationCertificateUnsigned) (*ActivationCertificate, error) {
	if len(workerSeed) != ed25519.SeedSize {
		return nil, fmt.Errorf("Worker Ed25519 seed must be 32 bytes")
	}
	unsigned, err := EncodeActivationCertificateUnsigned(value)
	if err != nil {
		return nil, err
	}
	input := controlJoinLP([]byte(activationCertificateDomain), unsigned)
	signature := ed25519.Sign(ed25519.NewKeyFromSeed(workerSeed), input)
	fields, err := activationCertificateUnsignedMap(value)
	if err != nil {
		return nil, err
	}
	fields[11] = signature
	encoded, err := EncodeCanonicalCBOR(fields)
	if err != nil {
		return nil, err
	}
	if len(encoded) > ActivationCertificateMaxBytes {
		return nil, controlAuthFailure("invalid_certificate", "activation certificate exceeds 384 bytes")
	}
	return &ActivationCertificate{
		ActivationCertificateUnsigned: value,
		Signature:                     append([]byte(nil), signature...), UnsignedCBOR: unsigned, EncodedCBOR: encoded,
	}, nil
}

func controlCBORUint(fields map[uint64]any, key uint64, name string) (uint64, error) {
	value, ok := fields[key].(uint64)
	if !ok {
		return 0, controlAuthFailure("invalid_certificate", name+" must be a CBOR unsigned integer")
	}
	return value, nil
}

func controlCBORBytes(fields map[uint64]any, key uint64, length int, name string) ([]byte, error) {
	value, ok := fields[key].([]byte)
	if !ok || len(value) != length {
		return nil, controlAuthFailure("invalid_certificate", fmt.Sprintf("%s must be %d CBOR bytes", name, length))
	}
	return append([]byte(nil), value...), nil
}

func DecodeActivationCertificate(encoded []byte) (*ActivationCertificate, error) {
	if len(encoded) < 1 || len(encoded) > ActivationCertificateMaxBytes {
		return nil, controlAuthFailure("invalid_certificate", "activation certificate is outside 1-384 bytes")
	}
	decoded, err := DecodeCanonicalCBOR(encoded)
	if err != nil {
		return nil, controlAuthFailure("invalid_certificate", "activation certificate is not canonical CBOR")
	}
	fields, ok := decoded.(map[uint64]any)
	if !ok || !exactKeys(fields, 11) {
		return nil, controlAuthFailure("invalid_certificate", "activation certificate fields are not exact")
	}
	version, err := controlCBORUint(fields, 1, "version")
	if err != nil {
		return nil, err
	}
	serial, err := controlCBORBytes(fields, 2, 16, "serial")
	if err != nil {
		return nil, err
	}
	installation, err := controlCBORBytes(fields, 3, 32, "installation public key")
	if err != nil {
		return nil, err
	}
	issuedAt, err := controlCBORUint(fields, 4, "issued-at")
	if err != nil {
		return nil, err
	}
	expiresAt, err := controlCBORUint(fields, 5, "expires-at")
	if err != nil {
		return nil, err
	}
	epoch, err := controlCBORUint(fields, 6, "credential epoch")
	if err != nil {
		return nil, err
	}
	major, err := controlCBORUint(fields, 7, "coordination major")
	if err != nil || major > math.MaxUint16 {
		return nil, controlAuthFailure("invalid_certificate", "coordination major exceeds uint16")
	}
	minor, err := controlCBORUint(fields, 8, "coordination minor")
	if err != nil || minor > math.MaxUint16 {
		return nil, controlAuthFailure("invalid_certificate", "coordination minor exceeds uint16")
	}
	quota, err := controlCBORUint(fields, 9, "quota tier")
	if err != nil {
		return nil, err
	}
	keyID, ok := fields[10].(string)
	if !ok {
		return nil, controlAuthFailure("invalid_certificate", "Worker key ID must be CBOR text")
	}
	signature, err := controlCBORBytes(fields, 11, 64, "signature")
	if err != nil {
		return nil, err
	}
	unsignedValue := ActivationCertificateUnsigned{
		Version: version, Serial: serial, InstallationPublicKey: installation,
		IssuedAt: issuedAt, ExpiresAt: expiresAt, CredentialEpoch: epoch,
		CoordinationMajor: uint16(major), CoordinationMinor: uint16(minor),
		QuotaTier: quota, WorkerSigningKeyID: keyID,
	}
	if err := validateActivationCertificateUnsigned(unsignedValue); err != nil {
		return nil, err
	}
	unsigned, err := EncodeActivationCertificateUnsigned(unsignedValue)
	if err != nil {
		return nil, err
	}
	return &ActivationCertificate{
		ActivationCertificateUnsigned: unsignedValue,
		Signature:                     signature, UnsignedCBOR: unsigned, EncodedCBOR: append([]byte(nil), encoded...),
	}, nil
}

type VerifyActivationCertificateOptions struct {
	WorkerKeys             map[string][]byte
	NowSeconds             uint64
	MinimumCredentialEpoch uint64
	RevokedSerials         map[string]bool
}

func VerifyActivationCertificate(encoded []byte, options VerifyActivationCertificateOptions) (*ActivationCertificate, error) {
	certificate, err := DecodeActivationCertificate(encoded)
	if err != nil {
		return nil, err
	}
	workerKey, ok := options.WorkerKeys[certificate.WorkerSigningKeyID]
	if !ok || len(workerKey) != ed25519.PublicKeySize {
		return nil, controlAuthFailure("unknown_worker_key", "certificate Worker key ID is not pinned")
	}
	input := controlJoinLP([]byte(activationCertificateDomain), certificate.UnsignedCBOR)
	if !ed25519.Verify(workerKey, input, certificate.Signature) {
		return nil, controlAuthFailure("invalid_certificate_signature", "activation certificate signature is invalid")
	}
	if options.NowSeconds < certificate.IssuedAt {
		return nil, controlAuthFailure("certificate_not_yet_valid", "activation certificate has not been issued")
	}
	if options.NowSeconds >= certificate.ExpiresAt {
		return nil, controlAuthFailure("certificate_expired", "activation certificate has expired")
	}
	if certificate.CredentialEpoch < options.MinimumCredentialEpoch {
		return nil, controlAuthFailure("credential_epoch_rollback", "activation certificate credential epoch rolled back")
	}
	if options.RevokedSerials[B64(certificate.Serial)] {
		return nil, controlAuthFailure("certificate_revoked", "activation certificate serial is revoked")
	}
	return certificate, nil
}

func ActivationCertificateRenewalState(certificate *ActivationCertificate, now uint64) string {
	if now < certificate.IssuedAt {
		return "not_yet_valid"
	}
	if now >= certificate.ExpiresAt {
		return "expired"
	}
	if certificate.ExpiresAt-now <= ActivationCertificateRenewal {
		return "renewal_due"
	}
	return "valid"
}

type HeaderTuple [2]string

type parsedControlHeaders struct {
	all        map[string]string
	auth       map[string]string
	normalized map[string]string
}

var allControlAuthHeaders = map[string]bool{
	protocolHeader: true, certificateHeader: true, installationKeyHeader: true,
	timestampHeader: true, requestNonceHeader: true, requestSignatureHeader: true,
	workerKeyIDHeader: true, responseNonceHeader: true, responseSignatureHeader: true,
}

func parseControlHeaders(raw []HeaderTuple, boundary string) (*parsedControlHeaders, error) {
	if boundary != "raw" && boundary != "normalized" {
		return nil, controlAuthFailure("invalid_header_name", "header boundary is unsupported")
	}
	result := &parsedControlHeaders{all: map[string]string{}, auth: map[string]string{}, normalized: map[string]string{}}
	authBytes := 0
	for _, tuple := range raw {
		rawName, value := tuple[0], tuple[1]
		if !controlHeaderNamePattern.MatchString(rawName) {
			return nil, controlAuthFailure("invalid_header_name", "header name is not an HTTP token")
		}
		name := strings.ToLower(rawName)
		if _, exists := result.all[name]; exists {
			return nil, controlAuthFailure("duplicate_header", name+" occurs more than once")
		}
		result.all[name] = value
		if !strings.HasPrefix(name, "x-waifus-") {
			continue
		}
		if boundary == "raw" && rawName != name {
			return nil, controlAuthFailure("invalid_header_name", "raw application names must be lower-case")
		}
		if !allControlAuthHeaders[name] {
			return nil, controlAuthFailure("unknown_auth_header", name+" is not a V1 authentication header")
		}
		if len(value) < 1 || strings.ContainsAny(value, " ,\t\r\n") {
			return nil, controlAuthFailure("invalid_header_value", "authentication header value is not printable non-whitespace ASCII")
		}
		for index := range value {
			if value[index] < 0x21 || value[index] > 0x7e {
				return nil, controlAuthFailure("invalid_header_value", "authentication header value is not printable ASCII")
			}
		}
		authBytes += len(value)
		if authBytes > ControlAuthHeaderValuesMaxBytes {
			return nil, controlAuthFailure("header_limit", "aggregate authentication values exceed 1024 bytes")
		}
		result.auth[name] = value
		result.normalized[name] = value
	}
	return result, nil
}

func requireExactControlAuth(parsed *parsedControlHeaders, required map[string]bool) error {
	for name := range required {
		if _, ok := parsed.auth[name]; !ok {
			return controlAuthFailure("missing_header", name+" is required")
		}
	}
	for name := range parsed.auth {
		if !required[name] {
			return controlAuthFailure("forbidden_header", name+" is forbidden for this envelope class")
		}
	}
	return nil
}

func canonicalControlB64(value string, length int, name string) ([]byte, error) {
	if !controlB64Pattern.MatchString(value) || strings.Contains(value, "=") {
		return nil, controlAuthFailure("invalid_header_value", name+" is not canonical base64url")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != length || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return nil, controlAuthFailure("invalid_header_value", fmt.Sprintf("%s must decode to %d bytes", name, length))
	}
	return decoded, nil
}

func canonicalControlUint64(value, name string) (uint64, error) {
	if !controlDecimalPattern.MatchString(value) {
		return 0, controlAuthFailure("invalid_header_value", name+" is not canonical uint64 decimal")
	}
	var result uint64
	for index := range value {
		digit := uint64(value[index] - '0')
		if result > (math.MaxUint64-digit)/10 {
			return 0, controlAuthFailure("invalid_header_value", name+" exceeds uint64")
		}
		result = result*10 + digit
	}
	if fmt.Sprintf("%d", result) != value {
		return 0, controlAuthFailure("invalid_header_value", name+" is noncanonical")
	}
	return result, nil
}

func validateControlMethod(method string) error {
	if len(method) < 1 || len(method) > 16 || !controlMethodPattern.MatchString(method) {
		return controlAuthFailure("invalid_request", "method must be uppercase ASCII")
	}
	return nil
}

func validateControlPath(path string) error {
	if len(path) < 1 || len(path) > 512 || path[0] != '/' || strings.ContainsAny(path, "?#%\\") {
		return controlAuthFailure("invalid_request", "pathname is not exact concrete ASCII")
	}
	for index := range path {
		if path[index] < 0x21 || path[index] > 0x7e {
			return controlAuthFailure("invalid_request", "pathname is not printable ASCII")
		}
	}
	return nil
}

func validateControlTimestamp(timestamp, now uint64) error {
	lower := uint64(0)
	if now >= ControlTimestampSkewSeconds {
		lower = now - ControlTimestampSkewSeconds
	}
	upper := uint64(math.MaxUint64)
	if now <= math.MaxUint64-ControlTimestampSkewSeconds {
		upper = now + ControlTimestampSkewSeconds
	}
	if timestamp < lower || timestamp > upper {
		return controlAuthFailure("timestamp_out_of_window", "signed timestamp is outside plus/minus 60 seconds")
	}
	return nil
}

func certificateControlRequestInput(method, path string, body []byte, certificate *ActivationCertificate, timestamp uint64, nonce []byte) ([]byte, error) {
	if err := validateControlMethod(method); err != nil {
		return nil, err
	}
	if err := validateControlPath(path); err != nil {
		return nil, err
	}
	if len(body) > ControlBodyMaxBytes || len(nonce) != 16 {
		return nil, controlAuthFailure("invalid_request", "request body or nonce width is invalid")
	}
	return controlJoinLP(
		[]byte(controlRequestDomain), []byte(method), []byte(path), controlHash(body),
		controlProtocolBytes(certificate.CoordinationMajor, certificate.CoordinationMinor),
		controlHash(certificate.EncodedCBOR), certificate.Serial, controlUint64(certificate.CredentialEpoch),
		certificate.InstallationPublicKey, []byte(certificate.WorkerSigningKeyID),
		controlUint64(timestamp), nonce,
	), nil
}

func ActivationControlRequestInput(class, method, path string, body, installation []byte, timestamp uint64, nonce []byte) ([]byte, error) {
	expectedPath, domain := "/v1/activation/challenges", activationBeginDomain
	if class == "activation_poll" {
		expectedPath, domain = "/v1/activation/poll", activationPollDomain
	} else if class != "activation_begin" {
		return nil, controlAuthFailure("invalid_request", "pre-certificate request class is unsupported")
	}
	if method != "POST" || path != expectedPath || len(body) > ControlBodyMaxBytes || len(installation) != 32 || len(nonce) != 16 {
		return nil, controlAuthFailure("invalid_request", "activation request method, route, body, key, or nonce is invalid")
	}
	return controlJoinLP(
		[]byte(domain), []byte(method), []byte(path), controlHash(body),
		controlProtocolBytes(1, 0), installation, controlUint64(timestamp), nonce,
	), nil
}

type CreatedControlRequest struct {
	RawHeaders            []HeaderTuple
	NormalizedAuthHeaders map[string]string
	SigningInput          []byte
	Signature             []byte
	RequestBindingHash    []byte
}

type CreateControlRequestInput struct {
	RequestClass               string
	Method                     string
	Path                       string
	Body                       []byte
	Timestamp                  uint64
	RequestNonce               []byte
	InstallationPrivateKeySeed []byte
	CertificateBytes           []byte
	WebSocketKey               string
}

func CreateControlRequest(input CreateControlRequestInput) (*CreatedControlRequest, error) {
	if len(input.InstallationPrivateKeySeed) != ed25519.SeedSize || len(input.RequestNonce) != 16 || len(input.Body) > ControlBodyMaxBytes {
		return nil, controlAuthFailure("invalid_request", "request seed, nonce, or body is invalid")
	}
	installation := ed25519.NewKeyFromSeed(input.InstallationPrivateKeySeed).Public().(ed25519.PublicKey)
	var signingInput []byte
	var headers []HeaderTuple
	var err error
	if input.RequestClass == "certificate" || input.RequestClass == "websocket" {
		certificate, decodeErr := DecodeActivationCertificate(input.CertificateBytes)
		if decodeErr != nil {
			return nil, decodeErr
		}
		if !bytes.Equal(certificate.InstallationPublicKey, installation) {
			return nil, controlAuthFailure("invalid_request", "certificate belongs to another installation key")
		}
		if input.RequestClass == "websocket" && len(input.Body) != 0 {
			return nil, controlAuthFailure("invalid_websocket", "WebSocket request body must be empty")
		}
		signingInput, err = certificateControlRequestInput(input.Method, input.Path, input.Body, certificate, input.Timestamp, input.RequestNonce)
		if err != nil {
			return nil, err
		}
		signature := ed25519.Sign(ed25519.NewKeyFromSeed(input.InstallationPrivateKeySeed), signingInput)
		headers = []HeaderTuple{
			{protocolHeader, "1.0"}, {certificateHeader, B64(certificate.EncodedCBOR)},
			{timestampHeader, fmt.Sprintf("%d", input.Timestamp)}, {requestNonceHeader, B64(input.RequestNonce)},
			{requestSignatureHeader, B64(signature)},
		}
	} else {
		signingInput, err = ActivationControlRequestInput(input.RequestClass, input.Method, input.Path, input.Body, installation, input.Timestamp, input.RequestNonce)
		if err != nil {
			return nil, err
		}
		signature := ed25519.Sign(ed25519.NewKeyFromSeed(input.InstallationPrivateKeySeed), signingInput)
		headers = []HeaderTuple{
			{protocolHeader, "1.0"}, {installationKeyHeader, B64(installation)},
			{timestampHeader, fmt.Sprintf("%d", input.Timestamp)}, {requestNonceHeader, B64(input.RequestNonce)},
			{requestSignatureHeader, B64(signature)},
		}
	}
	if input.RequestClass == "websocket" {
		if _, err := canonicalStandardBase64(input.WebSocketKey, 16, "Sec-WebSocket-Key"); err != nil {
			return nil, err
		}
		headers = append(headers,
			HeaderTuple{"connection", "Upgrade"}, HeaderTuple{"upgrade", "websocket"},
			HeaderTuple{"sec-websocket-key", input.WebSocketKey}, HeaderTuple{"sec-websocket-version", "13"},
			HeaderTuple{"sec-websocket-protocol", "waifus-control-v1"},
		)
	} else {
		headers = append(headers, HeaderTuple{"content-type", "application/json"})
	}
	parsed, err := parseControlHeaders(headers, "raw")
	if err != nil {
		return nil, err
	}
	signature, _ := base64.RawURLEncoding.DecodeString(headers[4][1])
	binding := controlHash(append(append([]byte(nil), signingInput...), signature...))
	return &CreatedControlRequest{
		RawHeaders: headers, NormalizedAuthHeaders: parsed.normalized,
		SigningInput: signingInput, Signature: signature, RequestBindingHash: binding,
	}, nil
}

func canonicalStandardBase64(value string, length int, name string) ([]byte, error) {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(decoded) != length || base64.StdEncoding.EncodeToString(decoded) != value {
		return nil, controlAuthFailure("invalid_websocket", fmt.Sprintf("%s must canonically decode to %d bytes", name, length))
	}
	return decoded, nil
}

func websocketAccept(key string) string {
	digest := sha1.Sum([]byte(key + webSocketGUID))
	return base64.StdEncoding.EncodeToString(digest[:])
}

func containsHTTPToken(value, expected string) bool {
	if value == "" {
		return false
	}
	found := false
	for _, raw := range strings.Split(value, ",") {
		token := strings.TrimSpace(raw)
		if token == "" || !controlHeaderNamePattern.MatchString(token) {
			return false
		}
		if strings.EqualFold(token, expected) {
			found = true
		}
	}
	return found
}

func requireWebSocketRequest(parsed *parsedControlHeaders) (string, error) {
	if _, exists := parsed.all["content-type"]; exists {
		return "", controlAuthFailure("invalid_websocket", "WebSocket request forbids Content-Type")
	}
	if _, exists := parsed.all["sec-websocket-extensions"]; exists {
		return "", controlAuthFailure("invalid_websocket", "WebSocket request forbids extensions")
	}
	if !containsHTTPToken(parsed.all["connection"], "upgrade") || strings.ToLower(parsed.all["upgrade"]) != "websocket" || parsed.all["sec-websocket-version"] != "13" || parsed.all["sec-websocket-protocol"] != "waifus-control-v1" {
		return "", controlAuthFailure("invalid_websocket", "WebSocket transport headers are invalid")
	}
	key := parsed.all["sec-websocket-key"]
	if _, err := canonicalStandardBase64(key, 16, "Sec-WebSocket-Key"); err != nil {
		return "", err
	}
	return key, nil
}

type ControlNonceEntry struct {
	Identity   string `json:"identity"`
	Nonce      string `json:"nonce"`
	AcceptedAt string `json:"acceptedAt"`
}

type ControlNonceSnapshot struct {
	Entries []ControlNonceEntry `json:"entries"`
}

type ControlNonceWindow struct {
	entries map[string]uint64
}

func NewControlNonceWindow(snapshot *ControlNonceSnapshot) (*ControlNonceWindow, error) {
	window := &ControlNonceWindow{entries: map[string]uint64{}}
	if snapshot == nil {
		return window, nil
	}
	if len(snapshot.Entries) > ControlNonceMaxEntries {
		return nil, controlAuthFailure("nonce_capacity", "nonce snapshot exceeds its fixed limit")
	}
	for _, entry := range snapshot.Entries {
		accepted, err := canonicalControlUint64(entry.AcceptedAt, "nonce accepted-at")
		if err != nil {
			return nil, err
		}
		nonce, err := canonicalControlB64(entry.Nonce, 16, "replay nonce")
		if err != nil {
			return nil, err
		}
		key := entry.Identity + ":" + B64(nonce)
		if len(entry.Identity) < 1 || len(entry.Identity) > 160 || !controlNonceIdentity.MatchString(entry.Identity) {
			return nil, controlAuthFailure("invalid_request", "nonce identity is invalid")
		}
		if _, exists := window.entries[key]; exists {
			return nil, controlAuthFailure("nonce_replay", "nonce snapshot contains a duplicate")
		}
		window.entries[key] = accepted
	}
	return window, nil
}

func (w *ControlNonceWindow) Accept(identity string, nonce []byte, now uint64) error {
	if len(identity) < 1 || len(identity) > 160 || len(nonce) != 16 || !controlNonceIdentity.MatchString(identity) {
		return controlAuthFailure("invalid_request", "nonce identity or width is invalid")
	}
	for key, accepted := range w.entries {
		if accepted <= now && now-accepted >= ControlNonceRetentionSeconds {
			delete(w.entries, key)
		}
	}
	key := identity + ":" + B64(nonce)
	if _, exists := w.entries[key]; exists {
		return controlAuthFailure("nonce_replay", "nonce was already accepted")
	}
	if len(w.entries) >= ControlNonceMaxEntries {
		return controlAuthFailure("nonce_capacity", "nonce replay window is at capacity")
	}
	w.entries[key] = now
	return nil
}

func (w *ControlNonceWindow) Snapshot() ControlNonceSnapshot {
	entries := make([]ControlNonceEntry, 0, len(w.entries))
	for key, accepted := range w.entries {
		separator := strings.LastIndex(key, ":")
		entries = append(entries, ControlNonceEntry{Identity: key[:separator], Nonce: key[separator+1:], AcceptedAt: fmt.Sprintf("%d", accepted)})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Identity == entries[j].Identity {
			return entries[i].Nonce < entries[j].Nonce
		}
		return entries[i].Identity < entries[j].Identity
	})
	return ControlNonceSnapshot{Entries: entries}
}

type VerifyControlRequestOptions struct {
	RequestClass           string
	Method                 string
	Path                   string
	Body                   []byte
	RawHeaders             []HeaderTuple
	WorkerKeys             map[string][]byte
	NowSeconds             uint64
	HeaderBoundary         string
	MinimumCredentialEpoch uint64
	RevokedSerials         map[string]bool
	NonceWindow            *ControlNonceWindow
}

type VerifiedControlRequest struct {
	InstallationPublicKey []byte
	Certificate           *ActivationCertificate
	Timestamp             uint64
	RequestNonce          []byte
	Signature             []byte
	SigningInput          []byte
	RequestBindingHash    []byte
	NormalizedAuthHeaders map[string]string
	WebSocketKey          string
}

func VerifyControlRequest(input VerifyControlRequestOptions) (*VerifiedControlRequest, error) {
	if err := validateControlMethod(input.Method); err != nil {
		return nil, err
	}
	if err := validateControlPath(input.Path); err != nil {
		return nil, err
	}
	if len(input.Body) > ControlBodyMaxBytes {
		return nil, controlAuthFailure("invalid_request", "raw body exceeds 2048 bytes")
	}
	parsed, err := parseControlHeaders(input.RawHeaders, input.HeaderBoundary)
	if err != nil {
		return nil, err
	}
	certificateClass := input.RequestClass == "certificate" || input.RequestClass == "websocket"
	required := map[string]bool{protocolHeader: true, timestampHeader: true, requestNonceHeader: true, requestSignatureHeader: true}
	if certificateClass {
		required[certificateHeader] = true
	} else {
		required[installationKeyHeader] = true
	}
	if err := requireExactControlAuth(parsed, required); err != nil {
		return nil, err
	}
	if parsed.auth[protocolHeader] != "1.0" {
		return nil, controlAuthFailure("invalid_header_value", "protocol must be exactly 1.0")
	}
	websocketKey := ""
	if input.RequestClass == "websocket" {
		if input.Method != "GET" || len(input.Body) != 0 {
			return nil, controlAuthFailure("invalid_websocket", "WebSocket upgrade must be a bodyless GET")
		}
		websocketKey, err = requireWebSocketRequest(parsed)
		if err != nil {
			return nil, err
		}
	} else if parsed.all["content-type"] != "application/json" {
		return nil, controlAuthFailure("invalid_request", "JSON request requires exact Content-Type")
	}
	timestamp, err := canonicalControlUint64(parsed.auth[timestampHeader], "request timestamp")
	if err != nil {
		return nil, err
	}
	if err := validateControlTimestamp(timestamp, input.NowSeconds); err != nil {
		return nil, err
	}
	nonce, err := canonicalControlB64(parsed.auth[requestNonceHeader], 16, "request nonce")
	if err != nil {
		return nil, err
	}
	signature, err := canonicalControlB64(parsed.auth[requestSignatureHeader], 64, "request signature")
	if err != nil {
		return nil, err
	}
	var certificate *ActivationCertificate
	var installation, signingInput []byte
	if certificateClass {
		text := parsed.auth[certificateHeader]
		if len(text) < 1 || len(text) > 512 || !controlB64Pattern.MatchString(text) {
			return nil, controlAuthFailure("invalid_header_value", "certificate header is not canonical")
		}
		certificateBytes, decodeErr := base64.RawURLEncoding.DecodeString(text)
		if decodeErr != nil || len(certificateBytes) > ActivationCertificateMaxBytes || B64(certificateBytes) != text {
			return nil, controlAuthFailure("invalid_header_value", "certificate header is invalid")
		}
		certificate, err = VerifyActivationCertificate(certificateBytes, VerifyActivationCertificateOptions{
			WorkerKeys: input.WorkerKeys, NowSeconds: input.NowSeconds,
			MinimumCredentialEpoch: input.MinimumCredentialEpoch, RevokedSerials: input.RevokedSerials,
		})
		if err != nil {
			return nil, err
		}
		installation = certificate.InstallationPublicKey
		signingInput, err = certificateControlRequestInput(input.Method, input.Path, input.Body, certificate, timestamp, nonce)
	} else {
		installation, err = canonicalControlB64(parsed.auth[installationKeyHeader], 32, "installation key")
		if err == nil {
			signingInput, err = ActivationControlRequestInput(input.RequestClass, input.Method, input.Path, input.Body, installation, timestamp, nonce)
		}
	}
	if err != nil {
		return nil, err
	}
	if !ed25519.Verify(installation, signingInput, signature) {
		return nil, controlAuthFailure("invalid_signature", "installation request signature is invalid")
	}
	if input.NonceWindow != nil {
		if err := input.NonceWindow.Accept("request:"+B64(installation), nonce, input.NowSeconds); err != nil {
			return nil, err
		}
	}
	binding := controlHash(append(append([]byte(nil), signingInput...), signature...))
	return &VerifiedControlRequest{
		InstallationPublicKey: installation, Certificate: certificate, Timestamp: timestamp,
		RequestNonce: nonce, Signature: signature, SigningInput: signingInput,
		RequestBindingHash: binding, NormalizedAuthHeaders: parsed.normalized, WebSocketKey: websocketKey,
	}, nil
}

func ControlResponseInput(path string, status uint16, body []byte, major, minor uint16, workerKeyID string, timestamp uint64, nonce, requestBinding []byte) ([]byte, error) {
	if err := validateControlPath(path); err != nil {
		return nil, err
	}
	if status < 100 || status > 599 || major != 1 || minor != 0 || len(body) > ControlBodyMaxBytes || len(nonce) != 16 || len(requestBinding) != 32 || !validWorkerKeyID(workerKeyID) {
		return nil, controlAuthFailure("invalid_response", "response body, nonce, binding, or Worker key ID is invalid")
	}
	return controlJoinLP(
		[]byte(controlResponseDomain), []byte(path), controlUint16(status), controlHash(body),
		controlProtocolBytes(major, minor), []byte(workerKeyID), controlUint64(timestamp), nonce, requestBinding,
	), nil
}

type CreateControlResponseInput struct {
	Path                 string
	Status               uint16
	Body                 []byte
	ProtocolMajor        uint16
	ProtocolMinor        uint16
	WorkerSigningKeyID   string
	Timestamp            uint64
	ResponseNonce        []byte
	RequestBindingHash   []byte
	WorkerPrivateKeySeed []byte
	WebSocketKey         string
}

type CreatedControlResponse struct {
	RawHeaders            []HeaderTuple
	NormalizedAuthHeaders map[string]string
	SigningInput          []byte
	Signature             []byte
}

func CreateControlResponse(input CreateControlResponseInput) (*CreatedControlResponse, error) {
	if (input.Status == 101) != (input.WebSocketKey != "") || len(input.WorkerPrivateKeySeed) != ed25519.SeedSize {
		return nil, controlAuthFailure("invalid_response", "response class or Worker seed is invalid")
	}
	if input.Status == 101 && len(input.Body) != 0 {
		return nil, controlAuthFailure("invalid_websocket", "WebSocket 101 body must be empty")
	}
	signingInput, err := ControlResponseInput(input.Path, input.Status, input.Body, input.ProtocolMajor, input.ProtocolMinor, input.WorkerSigningKeyID, input.Timestamp, input.ResponseNonce, input.RequestBindingHash)
	if err != nil {
		return nil, err
	}
	signature := ed25519.Sign(ed25519.NewKeyFromSeed(input.WorkerPrivateKeySeed), signingInput)
	headers := []HeaderTuple{
		{protocolHeader, fmt.Sprintf("%d.%d", input.ProtocolMajor, input.ProtocolMinor)},
		{workerKeyIDHeader, input.WorkerSigningKeyID}, {timestampHeader, fmt.Sprintf("%d", input.Timestamp)},
		{responseNonceHeader, B64(input.ResponseNonce)}, {responseSignatureHeader, B64(signature)},
	}
	if input.Status == 101 {
		if _, err := canonicalStandardBase64(input.WebSocketKey, 16, "Sec-WebSocket-Key"); err != nil {
			return nil, err
		}
		headers = append(headers,
			HeaderTuple{"connection", "Upgrade"}, HeaderTuple{"upgrade", "websocket"},
			HeaderTuple{"sec-websocket-accept", websocketAccept(input.WebSocketKey)},
			HeaderTuple{"sec-websocket-protocol", "waifus-control-v1"},
		)
	} else {
		headers = append(headers, HeaderTuple{"content-type", "application/json"})
	}
	parsed, err := parseControlHeaders(headers, "raw")
	if err != nil {
		return nil, err
	}
	return &CreatedControlResponse{RawHeaders: headers, NormalizedAuthHeaders: parsed.normalized, SigningInput: signingInput, Signature: signature}, nil
}

func requireWebSocketResponse(parsed *parsedControlHeaders, key string) error {
	if _, err := canonicalStandardBase64(key, 16, "Sec-WebSocket-Key"); err != nil {
		return err
	}
	if _, exists := parsed.all["content-type"]; exists {
		return controlAuthFailure("invalid_websocket", "WebSocket response forbids Content-Type")
	}
	if _, exists := parsed.all["sec-websocket-extensions"]; exists {
		return controlAuthFailure("invalid_websocket", "WebSocket response forbids extensions")
	}
	if !containsHTTPToken(parsed.all["connection"], "upgrade") || strings.ToLower(parsed.all["upgrade"]) != "websocket" || parsed.all["sec-websocket-protocol"] != "waifus-control-v1" || parsed.all["sec-websocket-accept"] != websocketAccept(key) {
		return controlAuthFailure("invalid_websocket", "WebSocket 101 transport headers are invalid")
	}
	return nil
}

func VerifyBrowserControlException(method, path string, body []byte, rawHeaders []HeaderTuple, boundary string) error {
	parsed, err := parseControlHeaders(rawHeaders, boundary)
	if err != nil {
		return err
	}
	if len(parsed.auth) != 0 {
		return controlAuthFailure("forbidden_header", "browser activation routes forbid every x-waifus-* header")
	}
	if path == "/activate" {
		if method != "GET" || len(body) != 0 {
			return controlAuthFailure("invalid_request", "browser activation document must be a bodyless GET")
		}
		if _, exists := parsed.all["content-type"]; exists {
			return controlAuthFailure("invalid_request", "browser activation document forbids Content-Type")
		}
		return nil
	}
	if path != "/v1/activation/complete" || method != "POST" || len(body) > TurnstileCompletionBodyMaxBytes || parsed.all["content-type"] != "application/json" {
		return controlAuthFailure("invalid_request", "browser activation completion must be a JSON POST within 4096 bytes")
	}
	return nil
}

type VerifyControlResponseOptions struct {
	Path                 string
	Status               uint16
	Body                 []byte
	RawHeaders           []HeaderTuple
	RequestBindingHash   []byte
	WorkerKeys           map[string][]byte
	NowSeconds           uint64
	HeaderBoundary       string
	ExpectedWebSocketKey string
	NonceWindow          *ControlNonceWindow
}

type VerifiedControlResponse struct {
	WorkerSigningKeyID    string
	Timestamp             uint64
	ResponseNonce         []byte
	Signature             []byte
	SigningInput          []byte
	NormalizedAuthHeaders map[string]string
}

func VerifyControlResponse(input VerifyControlResponseOptions) (*VerifiedControlResponse, error) {
	if err := validateControlPath(input.Path); err != nil {
		return nil, err
	}
	if len(input.Body) > ControlBodyMaxBytes {
		return nil, controlAuthFailure("invalid_response", "response body exceeds 2048 bytes")
	}
	parsed, err := parseControlHeaders(input.RawHeaders, input.HeaderBoundary)
	if err != nil {
		return nil, err
	}
	required := map[string]bool{protocolHeader: true, workerKeyIDHeader: true, timestampHeader: true, responseNonceHeader: true, responseSignatureHeader: true}
	if err := requireExactControlAuth(parsed, required); err != nil {
		return nil, err
	}
	if parsed.auth[protocolHeader] != "1.0" {
		return nil, controlAuthFailure("invalid_header_value", "protocol must be exactly 1.0")
	}
	if input.Status == 101 {
		if input.ExpectedWebSocketKey == "" || len(input.Body) != 0 {
			return nil, controlAuthFailure("invalid_websocket", "signed 101 requires expected key and empty body")
		}
		if err := requireWebSocketResponse(parsed, input.ExpectedWebSocketKey); err != nil {
			return nil, err
		}
	} else {
		if input.ExpectedWebSocketKey != "" {
			return nil, controlAuthFailure("invalid_response", "non-101 cannot be accepted as WebSocket response")
		}
		if parsed.all["content-type"] != "application/json" {
			return nil, controlAuthFailure("invalid_response", "signed JSON response requires exact Content-Type")
		}
	}
	workerKeyID := parsed.auth[workerKeyIDHeader]
	if !validWorkerKeyID(workerKeyID) {
		return nil, controlAuthFailure("invalid_header_value", "Worker key ID is invalid")
	}
	workerKey, ok := input.WorkerKeys[workerKeyID]
	if !ok || len(workerKey) != ed25519.PublicKeySize {
		return nil, controlAuthFailure("unknown_worker_key", "response Worker key is not pinned")
	}
	timestamp, err := canonicalControlUint64(parsed.auth[timestampHeader], "response timestamp")
	if err != nil {
		return nil, err
	}
	if err := validateControlTimestamp(timestamp, input.NowSeconds); err != nil {
		return nil, err
	}
	nonce, err := canonicalControlB64(parsed.auth[responseNonceHeader], 16, "response nonce")
	if err != nil {
		return nil, err
	}
	signature, err := canonicalControlB64(parsed.auth[responseSignatureHeader], 64, "response signature")
	if err != nil {
		return nil, err
	}
	signingInput, err := ControlResponseInput(input.Path, input.Status, input.Body, 1, 0, workerKeyID, timestamp, nonce, input.RequestBindingHash)
	if err != nil {
		return nil, err
	}
	if !ed25519.Verify(workerKey, signingInput, signature) {
		return nil, controlAuthFailure("invalid_signature", "Worker response signature is invalid")
	}
	if input.NonceWindow != nil {
		if err := input.NonceWindow.Accept("response:"+workerKeyID, nonce, input.NowSeconds); err != nil {
			return nil, err
		}
	}
	return &VerifiedControlResponse{
		WorkerSigningKeyID: workerKeyID, Timestamp: timestamp, ResponseNonce: nonce,
		Signature: signature, SigningInput: signingInput, NormalizedAuthHeaders: parsed.normalized,
	}, nil
}
