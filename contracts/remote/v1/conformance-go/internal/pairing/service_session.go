package pairing

import (
	"bytes"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

const (
	ApplicationSessionProtocolMajor = 1
	ApplicationDirectStreamID       = 1
)

var canonicalTargetRawPattern = regexp.MustCompile(`^[A-Za-z0-9\-._~!$&'()*+,;=:@/?]$`)
var approvalIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:._-]*$`)
var principalStableIDPattern = regexp.MustCompile(`^[a-z][a-z0-9:._-]*$`)
var sasFingerprintPattern = regexp.MustCompile(`^[0-9a-f]{12}$`)

type ServiceError struct {
	Code   string
	Detail string
}

func (e *ServiceError) Error() string {
	return e.Code + ": " + e.Detail
}

func serviceFailure(code, detail string) error {
	return &ServiceError{Code: code, Detail: detail}
}

type ApplicationSessionContext struct {
	NegotiatedMinor              uint16
	PairID                       []byte
	ServiceID                    []byte
	HostNonce                    []byte
	RemoteNonce                  []byte
	HostInstallationBundleHash   []byte
	RemoteInstallationBundleHash []byte
	HostTrustEpoch               uint64
	RemoteTrustEpoch             uint64
	HostTransportSessionID       []byte
	RemoteTransportSessionID     []byte
}

func validateApplicationSession(value ApplicationSessionContext) error {
	fields := []struct {
		name   string
		value  []byte
		length int
	}{
		{"pair ID", value.PairID, 16},
		{"service ID", value.ServiceID, 16},
		{"host nonce", value.HostNonce, 32},
		{"remote nonce", value.RemoteNonce, 32},
		{"host installation bundle hash", value.HostInstallationBundleHash, 32},
		{"remote installation bundle hash", value.RemoteInstallationBundleHash, 32},
		{"host transport session ID", value.HostTransportSessionID, 16},
		{"remote transport session ID", value.RemoteTransportSessionID, 16},
	}
	for _, field := range fields {
		if len(field.value) != field.length {
			return fmt.Errorf("%s must be %d bytes", field.name, field.length)
		}
	}
	if hmac.Equal(value.HostNonce, value.RemoteNonce) {
		return fmt.Errorf("host and remote nonces must differ")
	}
	if hmac.Equal(value.HostInstallationBundleHash, value.RemoteInstallationBundleHash) {
		return fmt.Errorf("host and remote installation bundle hashes must differ")
	}
	if hmac.Equal(value.HostTransportSessionID, value.RemoteTransportSessionID) {
		return fmt.Errorf("host and remote transport session IDs must differ")
	}
	return nil
}

func uint16Bytes(value uint16) []byte {
	encoded := make([]byte, 2)
	binary.BigEndian.PutUint16(encoded, value)
	return encoded
}

func uint64Bytes(value uint64) []byte {
	encoded := make([]byte, 8)
	binary.BigEndian.PutUint64(encoded, value)
	return encoded
}

func EncodeApplicationSessionSignedBytes(value ApplicationSessionContext) ([]byte, error) {
	if err := validateApplicationSession(value); err != nil {
		return nil, err
	}
	protocol := append(uint16Bytes(ApplicationSessionProtocolMajor), uint16Bytes(value.NegotiatedMinor)...)
	return bytes.Join([][]byte{
		LP([]byte("waifus-app-session-v1")),
		LP(protocol),
		LP(value.PairID),
		LP(value.ServiceID),
		LP(value.HostNonce),
		LP(value.RemoteNonce),
		LP(value.HostInstallationBundleHash),
		LP(value.RemoteInstallationBundleHash),
		LP(uint64Bytes(value.HostTrustEpoch)),
		LP(uint64Bytes(value.RemoteTrustEpoch)),
		LP(value.HostTransportSessionID),
		LP(value.RemoteTransportSessionID),
	}, nil), nil
}

type appSessionDecoder struct {
	value  []byte
	offset int
}

func (d *appSessionDecoder) read(length int) ([]byte, error) {
	if length < 0 || d.offset+length > len(d.value) {
		return nil, serviceFailure("invalid_application_session", "application-session bytes are truncated")
	}
	result := d.value[d.offset : d.offset+length]
	d.offset += length
	return result, nil
}

func (d *appSessionDecoder) lp(expected int, name string) ([]byte, error) {
	lengthBytes, err := d.read(4)
	if err != nil {
		return nil, err
	}
	length := int(binary.BigEndian.Uint32(lengthBytes))
	if length != expected {
		return nil, serviceFailure("invalid_application_session", name+" has the wrong encoded width")
	}
	return d.read(length)
}

func DecodeApplicationSessionSignedBytes(payload []byte, expectedMinor *uint16) (ApplicationSessionContext, error) {
	d := &appSessionDecoder{value: append([]byte(nil), payload...)}
	domain, err := d.lp(len("waifus-app-session-v1"), "domain")
	if err != nil {
		return ApplicationSessionContext{}, err
	}
	if string(domain) != "waifus-app-session-v1" {
		return ApplicationSessionContext{}, serviceFailure("invalid_application_session", "application-session domain does not match V1")
	}
	protocol, err := d.lp(4, "protocol")
	if err != nil {
		return ApplicationSessionContext{}, err
	}
	if binary.BigEndian.Uint16(protocol[:2]) != ApplicationSessionProtocolMajor {
		return ApplicationSessionContext{}, serviceFailure("invalid_application_session", "application-session protocol major is unsupported")
	}
	minor := binary.BigEndian.Uint16(protocol[2:])
	if expectedMinor != nil && minor != *expectedMinor {
		return ApplicationSessionContext{}, serviceFailure("invalid_application_session", "application-session minor was not negotiated")
	}
	read := func(length int, name string) ([]byte, error) {
		value, readErr := d.lp(length, name)
		return append([]byte(nil), value...), readErr
	}
	result := ApplicationSessionContext{NegotiatedMinor: minor}
	if result.PairID, err = read(16, "pair ID"); err != nil {
		return ApplicationSessionContext{}, err
	}
	if result.ServiceID, err = read(16, "service ID"); err != nil {
		return ApplicationSessionContext{}, err
	}
	if result.HostNonce, err = read(32, "host nonce"); err != nil {
		return ApplicationSessionContext{}, err
	}
	if result.RemoteNonce, err = read(32, "remote nonce"); err != nil {
		return ApplicationSessionContext{}, err
	}
	if result.HostInstallationBundleHash, err = read(32, "host bundle hash"); err != nil {
		return ApplicationSessionContext{}, err
	}
	if result.RemoteInstallationBundleHash, err = read(32, "remote bundle hash"); err != nil {
		return ApplicationSessionContext{}, err
	}
	hostEpoch, err := read(8, "host trust epoch")
	if err != nil {
		return ApplicationSessionContext{}, err
	}
	result.HostTrustEpoch = binary.BigEndian.Uint64(hostEpoch)
	remoteEpoch, err := read(8, "remote trust epoch")
	if err != nil {
		return ApplicationSessionContext{}, err
	}
	result.RemoteTrustEpoch = binary.BigEndian.Uint64(remoteEpoch)
	if result.HostTransportSessionID, err = read(16, "host transport session ID"); err != nil {
		return ApplicationSessionContext{}, err
	}
	if result.RemoteTransportSessionID, err = read(16, "remote transport session ID"); err != nil {
		return ApplicationSessionContext{}, err
	}
	if d.offset != len(d.value) {
		return ApplicationSessionContext{}, serviceFailure("invalid_application_session", "application-session bytes contain trailing data")
	}
	if err := validateApplicationSession(result); err != nil {
		return ApplicationSessionContext{}, serviceFailure("invalid_application_session", err.Error())
	}
	return result, nil
}

type ApplicationSessionProofs struct {
	SignedBytes            []byte
	Digest                 []byte
	HostSignature          []byte
	RemoteSignature        []byte
	ApplicationSessionHash []byte
}

func CreateApplicationSessionProofs(value ApplicationSessionContext, hostSeed, remoteSeed []byte) (*ApplicationSessionProofs, error) {
	if len(hostSeed) != ed25519.SeedSize || len(remoteSeed) != ed25519.SeedSize {
		return nil, fmt.Errorf("installation seed must be 32 bytes")
	}
	signedBytes, err := EncodeApplicationSessionSignedBytes(value)
	if err != nil {
		return nil, err
	}
	digest := Hash(signedBytes)
	hostSignature := ed25519.Sign(ed25519.NewKeyFromSeed(hostSeed), digest)
	remoteSignature := ed25519.Sign(ed25519.NewKeyFromSeed(remoteSeed), digest)
	return &ApplicationSessionProofs{
		SignedBytes:            signedBytes,
		Digest:                 digest,
		HostSignature:          hostSignature,
		RemoteSignature:        remoteSignature,
		ApplicationSessionHash: Hash(signedBytes, hostSignature, remoteSignature),
	}, nil
}

func VerifyApplicationSessionProofs(
	value ApplicationSessionContext,
	hostPublic, remotePublic, hostSignature, remoteSignature []byte,
) bool {
	signedBytes, err := EncodeApplicationSessionSignedBytes(value)
	if err != nil || len(hostPublic) != ed25519.PublicKeySize || len(remotePublic) != ed25519.PublicKeySize ||
		len(hostSignature) != ed25519.SignatureSize || len(remoteSignature) != ed25519.SignatureSize {
		return false
	}
	digest := Hash(signedBytes)
	return ed25519.Verify(hostPublic, digest, hostSignature) && ed25519.Verify(remotePublic, digest, remoteSignature)
}

type ApplicationSessionAuthentication struct {
	Role  string
	State string
}

func NewApplicationSessionAuthentication(role string) (*ApplicationSessionAuthentication, error) {
	if role != "host" && role != "remote" {
		return nil, fmt.Errorf("application-session role must be host or remote")
	}
	return &ApplicationSessionAuthentication{Role: role, State: "idle"}, nil
}

func (a *ApplicationSessionAuthentication) Transition(event string) error {
	type transition struct{ event, next string }
	transitions := map[string]map[string]transition{
		"remote": {
			"idle":               {"send_hello", "hello_sent"},
			"hello_sent":         {"receive_verified_hello_ack", "host_authenticated"},
			"host_authenticated": {"send_authenticate_peer", "peer_auth_sent"},
			"peer_auth_sent":     {"receive_success_result", "authenticated"},
		},
		"host": {
			"idle":                 {"receive_hello", "hello_received"},
			"hello_received":       {"send_hello_ack", "hello_ack_sent"},
			"hello_ack_sent":       {"receive_verified_authenticate_peer", "remote_authenticated"},
			"remote_authenticated": {"send_success_result", "authenticated"},
		},
	}
	next, ok := transitions[a.Role][a.State]
	if !ok || next.event != event {
		return serviceFailure("auth_sequence_error", fmt.Sprintf("%s cannot %s while application authentication is %s", a.Role, event, a.State))
	}
	a.State = next.next
	return nil
}

func (a *ApplicationSessionAuthentication) CanAcceptRequestStart() bool {
	return a.State == "authenticated"
}

type RemoteBrowserContext struct {
	Version          int    `json:"version"`
	GatewayLaunchID  string `json:"gatewayLaunchId"`
	BrowserSessionID string `json:"browserSessionId"`
	RequestNonce     string `json:"requestNonce"`
	Method           string `json:"method"`
	CanonicalTarget  string `json:"canonicalTarget"`
	CSRFValidated    bool   `json:"csrfValidated"`
}

type RemoteBrowserContextEnvelope struct {
	Version                      int                  `json:"version"`
	BrowserContext               RemoteBrowserContext `json:"browserContext"`
	PairID                       string               `json:"pairId"`
	RemoteDeviceID               string               `json:"remoteDeviceId"`
	RemoteInstallationBundleHash string               `json:"remoteInstallationBundleHash"`
	HostTrustEpoch               string               `json:"hostTrustEpoch"`
	RemoteTrustEpoch             string               `json:"remoteTrustEpoch"`
	ApplicationSessionHash       string               `json:"applicationSessionHash"`
	DirectRequestID              string               `json:"directRequestId"`
	RemoteParentStreamID         string               `json:"remoteParentStreamId"`
	DirectStreamID               string               `json:"directStreamId"`
	MAC                          string               `json:"mac"`
}

func isUnreserved(value byte) bool {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z' || value >= '0' && value <= '9' || strings.ContainsRune("-._~", rune(value))
}

func isCanonicalTarget(value string) bool {
	if len(value) < 1 || len(value) > 2048 || value[0] != '/' || strings.HasPrefix(value, "//") || strings.ContainsAny(value, "#\\") {
		return false
	}
	for index := 0; index < len(value); index++ {
		current := value[index]
		if current < 0x21 || current > 0x7e {
			return false
		}
		if current == '%' {
			if index+2 >= len(value) {
				return false
			}
			hex := value[index+1 : index+3]
			if !regexp.MustCompile(`^[0-9A-F]{2}$`).MatchString(hex) {
				return false
			}
			parsed, err := strconv.ParseUint(hex, 16, 8)
			decoded := byte(parsed)
			if err != nil || decoded == '/' || decoded == '\\' || isUnreserved(decoded) {
				return false
			}
			index += 2
			continue
		}
		if !canonicalTargetRawPattern.MatchString(string(current)) {
			return false
		}
	}
	pathname := strings.SplitN(value, "?", 2)[0]
	for _, segment := range strings.Split(pathname, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func ValidateRemoteBrowserContext(value RemoteBrowserContext) error {
	if value.Version != 1 || !value.CSRFValidated {
		return fmt.Errorf("browser context version or CSRF result is invalid")
	}
	for name, field := range map[string]string{
		"gateway launch ID":  value.GatewayLaunchID,
		"browser session ID": value.BrowserSessionID,
	} {
		decoded, err := DecodeB64(field)
		if err != nil || len(decoded) != 32 {
			return fmt.Errorf("%s must be canonical 32-byte base64url", name)
		}
	}
	nonce, err := DecodeB64(value.RequestNonce)
	if err != nil || len(nonce) != 16 {
		return fmt.Errorf("request nonce must be canonical 16-byte base64url")
	}
	switch value.Method {
	case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE":
	default:
		return fmt.Errorf("browser method is not a closed V1 value")
	}
	if !isCanonicalTarget(value.CanonicalTarget) {
		return fmt.Errorf("browser target is not canonical origin form")
	}
	return nil
}

func parseServiceUint64(value, name string) (uint64, error) {
	parsed, err := confirmationGeneration(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be canonical uint64", name)
	}
	return parsed, nil
}

func ValidateRemoteBrowserContextEnvelope(value RemoteBrowserContextEnvelope) error {
	if value.Version != 1 {
		return fmt.Errorf("browser envelope version must be 1")
	}
	if err := ValidateRemoteBrowserContext(value.BrowserContext); err != nil {
		return err
	}
	for _, field := range []struct {
		name string
		text string
		size int
	}{
		{"pair ID", value.PairID, 16},
		{"remote installation bundle hash", value.RemoteInstallationBundleHash, 32},
		{"application-session hash", value.ApplicationSessionHash, 32},
		{"direct request ID", value.DirectRequestID, 16},
		{"browser context MAC", value.MAC, 32},
	} {
		decoded, err := DecodeB64(field.text)
		if err != nil || len(decoded) != field.size {
			return fmt.Errorf("%s must be canonical %d-byte base64url", field.name, field.size)
		}
	}
	if !deviceIDPattern.MatchString(value.RemoteDeviceID) || len(value.RemoteDeviceID) > 64 {
		return fmt.Errorf("remote device ID is not canonical")
	}
	if _, err := parseServiceUint64(value.HostTrustEpoch, "host trust epoch"); err != nil {
		return err
	}
	if _, err := parseServiceUint64(value.RemoteTrustEpoch, "remote trust epoch"); err != nil {
		return err
	}
	parent, err := parseServiceUint64(value.RemoteParentStreamID, "remote parent stream ID")
	if err != nil {
		return err
	}
	if parent == 0 || parent%2 == 0 {
		return fmt.Errorf("remote parent stream ID must be positive and odd")
	}
	if value.DirectStreamID != "1" {
		return fmt.Errorf("direct stream ID must be 1")
	}
	return nil
}

func CanonicalJSONV1(value any) ([]byte, error) {
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

func CanonicalRemoteBrowserContextJSON(value RemoteBrowserContext) ([]byte, error) {
	if err := ValidateRemoteBrowserContext(value); err != nil {
		return nil, err
	}
	return CanonicalJSONV1(value)
}

func ParseCanonicalRemoteBrowserContext(payload []byte) (RemoteBrowserContext, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var value RemoteBrowserContext
	if err := decoder.Decode(&value); err != nil {
		return RemoteBrowserContext{}, serviceFailure("invalid_browser_context", "browser context is not strict JSON")
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return RemoteBrowserContext{}, serviceFailure("invalid_browser_context", "browser context has trailing JSON")
	}
	canonical, err := CanonicalRemoteBrowserContextJSON(value)
	if err != nil || !bytes.Equal(canonical, payload) {
		return RemoteBrowserContext{}, serviceFailure("invalid_browser_context", "browser context is not canonical V1 JSON")
	}
	return value, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("extra JSON value")
		}
		return err
	}
	return nil
}

func DeriveRemoteBrowserContextKey(pairRoot, applicationSessionHash []byte, session ApplicationSessionContext) ([]byte, error) {
	if len(pairRoot) != 32 || len(applicationSessionHash) != 32 {
		return nil, fmt.Errorf("pair root and application-session hash must be 32 bytes")
	}
	if err := validateApplicationSession(session); err != nil {
		return nil, err
	}
	info := bytes.Join([][]byte{
		[]byte("waifus/browser-context-key/v1"), {0},
		session.PairID, session.ServiceID,
		session.HostInstallationBundleHash, session.RemoteInstallationBundleHash,
		uint64Bytes(session.HostTrustEpoch), uint64Bytes(session.RemoteTrustEpoch),
		session.HostTransportSessionID, session.RemoteTransportSessionID,
	}, nil)
	return HKDF(pairRoot, applicationSessionHash, info, 32)
}

func RemoteBrowserContextMACInput(value RemoteBrowserContextEnvelope) ([]byte, error) {
	if err := ValidateRemoteBrowserContextEnvelope(value); err != nil {
		return nil, err
	}
	context, err := CanonicalRemoteBrowserContextJSON(value.BrowserContext)
	if err != nil {
		return nil, err
	}
	pairID, _ := DecodeB64(value.PairID)
	remoteBundleHash, _ := DecodeB64(value.RemoteInstallationBundleHash)
	hostEpoch, _ := parseServiceUint64(value.HostTrustEpoch, "host trust epoch")
	remoteEpoch, _ := parseServiceUint64(value.RemoteTrustEpoch, "remote trust epoch")
	appSessionHash, _ := DecodeB64(value.ApplicationSessionHash)
	directRequestID, _ := DecodeB64(value.DirectRequestID)
	parentStreamID, _ := parseServiceUint64(value.RemoteParentStreamID, "remote parent stream ID")
	return bytes.Join([][]byte{
		LP([]byte("waifus/remote-browser-context/v1")),
		LP(context),
		LP(pairID),
		LP([]byte(value.RemoteDeviceID)),
		LP(remoteBundleHash),
		LP(uint64Bytes(hostEpoch)),
		LP(uint64Bytes(remoteEpoch)),
		LP(appSessionHash),
		LP(directRequestID),
		LP(uint64Bytes(parentStreamID)),
		LP(uint64Bytes(ApplicationDirectStreamID)),
	}, nil), nil
}

func DeriveRemoteBrowserContextMAC(key []byte, value RemoteBrowserContextEnvelope) ([]byte, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("browser-context key must be 32 bytes")
	}
	input, err := RemoteBrowserContextMACInput(value)
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(input)
	return mac.Sum(nil), nil
}

func VerifyRemoteBrowserContextMAC(key []byte, value RemoteBrowserContextEnvelope) bool {
	actual, err := DecodeB64(value.MAC)
	if err != nil || len(actual) != 32 {
		return false
	}
	expected, err := DeriveRemoteBrowserContextMAC(key, value)
	return err == nil && hmac.Equal(actual, expected)
}

func SignRemoteBrowserContextEnvelope(key []byte, value RemoteBrowserContextEnvelope) (RemoteBrowserContextEnvelope, error) {
	value.MAC = B64(make([]byte, 32))
	mac, err := DeriveRemoteBrowserContextMAC(key, value)
	if err != nil {
		return RemoteBrowserContextEnvelope{}, err
	}
	value.MAC = B64(mac)
	return value, ValidateRemoteBrowserContextEnvelope(value)
}

type RemoteBrowserReplayConfig struct {
	PairID                       string
	RemoteDeviceID               string
	RemoteInstallationBundleHash string
	HostTrustEpoch               string
	RemoteTrustEpoch             string
	GatewayLaunchID              string
	BrowserSessionID             string
	GatewayExpiresAt             string
}

type RemoteBrowserReplayGuard struct {
	config           RemoteBrowserReplayConfig
	requestNonces    map[string]struct{}
	directRequestIDs map[string]struct{}
	parentHighWater  uint64
}

func NewRemoteBrowserReplayGuard(config RemoteBrowserReplayConfig) (*RemoteBrowserReplayGuard, error) {
	dummy := RemoteBrowserContextEnvelope{
		Version:        1,
		BrowserContext: RemoteBrowserContext{Version: 1, GatewayLaunchID: config.GatewayLaunchID, BrowserSessionID: config.BrowserSessionID, RequestNonce: B64(make([]byte, 16)), Method: "GET", CanonicalTarget: "/", CSRFValidated: true},
		PairID:         config.PairID, RemoteDeviceID: config.RemoteDeviceID,
		RemoteInstallationBundleHash: config.RemoteInstallationBundleHash,
		HostTrustEpoch:               config.HostTrustEpoch, RemoteTrustEpoch: config.RemoteTrustEpoch,
		ApplicationSessionHash: B64(make([]byte, 32)), DirectRequestID: B64(make([]byte, 16)),
		RemoteParentStreamID: "1", DirectStreamID: "1", MAC: B64(make([]byte, 32)),
	}
	if err := ValidateRemoteBrowserContextEnvelope(dummy); err != nil {
		return nil, err
	}
	if _, err := parseServiceUint64(config.GatewayExpiresAt, "gateway expiry"); err != nil {
		return nil, err
	}
	return &RemoteBrowserReplayGuard{
		config:           config,
		requestNonces:    make(map[string]struct{}),
		directRequestIDs: make(map[string]struct{}),
	}, nil
}

func (g *RemoteBrowserReplayGuard) VerifyAndConsume(
	value RemoteBrowserContextEnvelope,
	key []byte,
	applicationSessionHash, now, method, canonicalTarget string,
) error {
	if err := ValidateRemoteBrowserContextEnvelope(value); err != nil {
		return serviceFailure("invalid_browser_context", err.Error())
	}
	if !VerifyRemoteBrowserContextMAC(key, value) {
		return serviceFailure("invalid_browser_context_mac", "remote-browser context MAC does not verify")
	}
	checks := []struct{ actual, expected, code, detail string }{
		{value.PairID, g.config.PairID, "wrong_pair", "remote-browser pair ID does not match current trust"},
		{value.RemoteDeviceID, g.config.RemoteDeviceID, "wrong_remote_device", "remote-browser device ID does not match current trust"},
		{value.RemoteInstallationBundleHash, g.config.RemoteInstallationBundleHash, "wrong_remote_bundle", "remote-browser bundle hash does not match current trust"},
		{value.HostTrustEpoch, g.config.HostTrustEpoch, "wrong_trust_epoch", "remote-browser host trust epoch does not match current trust"},
		{value.RemoteTrustEpoch, g.config.RemoteTrustEpoch, "wrong_trust_epoch", "remote-browser remote trust epoch does not match current trust"},
		{value.ApplicationSessionHash, applicationSessionHash, "wrong_application_session", "remote-browser proof is bound to another app session"},
		{value.BrowserContext.GatewayLaunchID, g.config.GatewayLaunchID, "stale_gateway_launch", "remote-browser gateway launch is not current"},
		{value.BrowserContext.BrowserSessionID, g.config.BrowserSessionID, "stale_browser_session", "remote-browser session is not current"},
	}
	for _, check := range checks {
		if check.actual != check.expected {
			return serviceFailure(check.code, check.detail)
		}
	}
	nowValue, err := parseServiceUint64(now, "current time")
	if err != nil {
		return err
	}
	expiresAt, _ := parseServiceUint64(g.config.GatewayExpiresAt, "gateway expiry")
	if nowValue > expiresAt {
		return serviceFailure("gateway_launch_expired", "remote-browser gateway launch has expired")
	}
	if value.BrowserContext.Method != method || value.BrowserContext.CanonicalTarget != canonicalTarget || !isCanonicalTarget(canonicalTarget) {
		return serviceFailure("request_binding_mismatch", "remote-browser method or target does not match REQUEST_START")
	}
	if _, exists := g.requestNonces[value.BrowserContext.RequestNonce]; exists {
		return serviceFailure("replayed_request_nonce", "remote-browser request nonce was already consumed")
	}
	if _, exists := g.directRequestIDs[value.DirectRequestID]; exists {
		return serviceFailure("replayed_direct_request_id", "direct request ID was already consumed")
	}
	parent, _ := parseServiceUint64(value.RemoteParentStreamID, "remote parent stream ID")
	if parent <= g.parentHighWater {
		return serviceFailure("stale_parent_stream", "remote parent stream ID is not above the high-water mark")
	}
	g.requestNonces[value.BrowserContext.RequestNonce] = struct{}{}
	g.directRequestIDs[value.DirectRequestID] = struct{}{}
	g.parentHighWater = parent
	return nil
}

func approvalObject(value any, name string) (map[string]any, error) {
	result, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an object", name)
	}
	return result, nil
}

func approvalString(value any, name string) (string, error) {
	result, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("%s must be a string", name)
	}
	return result, nil
}

func approvalInteger(value any, name string) (int64, error) {
	text, ok := value.(json.Number)
	if !ok {
		return 0, fmt.Errorf("%s must be a JSON integer", name)
	}
	result, err := text.Int64()
	if err != nil || text.String() != fmt.Sprintf("%d", result) {
		return 0, fmt.Errorf("%s must be a JSON integer", name)
	}
	return result, nil
}

func approvalExactKeys(value map[string]any, required []string, optional ...string) error {
	allowed := make(map[string]struct{}, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = struct{}{}
		if _, ok := value[key]; !ok {
			return fmt.Errorf("missing approval field %s", key)
		}
	}
	for _, key := range optional {
		allowed[key] = struct{}{}
	}
	for key := range value {
		if _, ok := allowed[key]; !ok {
			return fmt.Errorf("unknown approval field %s", key)
		}
	}
	return nil
}

func approvalB64(value any, length int, name string) (string, error) {
	text, err := approvalString(value, name)
	if err != nil {
		return "", err
	}
	decoded, err := DecodeB64(text)
	if err != nil || len(decoded) != length {
		return "", fmt.Errorf("%s must be canonical base64url for %d bytes", name, length)
	}
	return text, nil
}

func approvalUint64(value any, name string) (uint64, error) {
	text, err := approvalString(value, name)
	if err != nil {
		return 0, err
	}
	return parseServiceUint64(text, name)
}

func normalizeApprovalMap(value any) (map[string]any, error) {
	encoded, err := CanonicalJSONV1(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var normalized map[string]any
	if err := decoder.Decode(&normalized); err != nil {
		return nil, err
	}
	return normalized, nil
}

func ValidateApprovalReceiptV1(input any) error {
	value, err := normalizeApprovalMap(input)
	if err != nil {
		return err
	}
	required := []string{
		"version", "receiptId", "issuedAt", "expiresAt", "invitationId", "invitationGeneration",
		"pendingPairId", "hostIdentityBundleCbor", "hostIdentityBundleHash",
		"remoteIdentityBundleCbor", "remoteIdentityBundleHash", "noisePattern", "protocol",
		"transcriptHash", "channelBinding", "sasIndices", "sasFingerprint", "hostTrustEpoch",
		"remoteTrustEpoch", "hostKeySequence", "remoteKeySequence", "approvingPrincipal",
		"browserBinding", "confirmationRequestNonce", "confirmationMethod", "confirmationTarget",
		"nonce", "action",
	}
	if err := approvalExactKeys(value, required, "assistantProvenance"); err != nil {
		return err
	}
	version, err := approvalInteger(value["version"], "version")
	if err != nil || version != 1 {
		return fmt.Errorf("approval version must be 1")
	}
	for _, field := range []struct {
		name   string
		length int
	}{
		{"receiptId", 32}, {"invitationId", 16}, {"pendingPairId", 16},
		{"hostIdentityBundleHash", 32}, {"remoteIdentityBundleHash", 32},
		{"transcriptHash", 32}, {"channelBinding", 32}, {"confirmationRequestNonce", 16}, {"nonce", 32},
	} {
		if _, err := approvalB64(value[field.name], field.length, field.name); err != nil {
			return err
		}
	}
	issuedAt, err := approvalUint64(value["issuedAt"], "issuedAt")
	if err != nil {
		return err
	}
	expiresAt, err := approvalUint64(value["expiresAt"], "expiresAt")
	if err != nil || expiresAt <= issuedAt || expiresAt-issuedAt > 120 {
		return fmt.Errorf("approval expiry must be within 120 seconds after issue")
	}
	for _, field := range []string{"invitationGeneration", "hostTrustEpoch", "remoteTrustEpoch"} {
		if _, err := approvalUint64(value[field], field); err != nil {
			return err
		}
	}
	hostCBOR, err := approvalString(value["hostIdentityBundleCbor"], "hostIdentityBundleCbor")
	if err != nil {
		return err
	}
	remoteCBOR, err := approvalString(value["remoteIdentityBundleCbor"], "remoteIdentityBundleCbor")
	if err != nil {
		return err
	}
	for name, encoded := range map[string]string{"host identity bundle": hostCBOR, "remote identity bundle": remoteCBOR} {
		decoded, err := DecodeB64(encoded)
		if err != nil || len(decoded) < 1 || len(decoded) > 1200 {
			return fmt.Errorf("%s must be canonical base64url for 1-1200 bytes", name)
		}
	}
	hostHash, _ := approvalString(value["hostIdentityBundleHash"], "hostIdentityBundleHash")
	remoteHash, _ := approvalString(value["remoteIdentityBundleHash"], "remoteIdentityBundleHash")
	if hostCBOR == remoteCBOR || hostHash == remoteHash {
		return fmt.Errorf("host and remote identity bundles must differ")
	}
	noisePattern, err := approvalString(value["noisePattern"], "noisePattern")
	if err != nil || noisePattern != NoiseXXPattern && noisePattern != NoiseXXPSK0Pattern {
		return fmt.Errorf("approval noise pattern is not a closed V1 value")
	}
	protocol, err := approvalObject(value["protocol"], "protocol")
	if err != nil || approvalExactKeys(protocol, []string{"major", "minor"}) != nil {
		return fmt.Errorf("approval protocol must contain exact major/minor fields")
	}
	major, err := approvalInteger(protocol["major"], "protocol major")
	if err != nil || major < 0 || major > 65535 {
		return fmt.Errorf("protocol major must be uint16")
	}
	minor, err := approvalInteger(protocol["minor"], "protocol minor")
	if err != nil || minor < 0 || minor > 65535 {
		return fmt.Errorf("protocol minor must be uint16")
	}
	indices, ok := value["sasIndices"].([]any)
	if !ok || len(indices) != 5 {
		return fmt.Errorf("approval SAS must contain five indices")
	}
	for _, index := range indices {
		parsed, err := approvalInteger(index, "SAS index")
		if err != nil || parsed < 0 || parsed > 1023 {
			return fmt.Errorf("approval SAS index is outside 0-1023")
		}
	}
	fingerprint, err := approvalString(value["sasFingerprint"], "sasFingerprint")
	if err != nil || !sasFingerprintPattern.MatchString(fingerprint) {
		return fmt.Errorf("approval SAS fingerprint is not 12 lowercase hex characters")
	}
	for _, field := range []string{"hostKeySequence", "remoteKeySequence"} {
		sequence, err := approvalInteger(value[field], field)
		if err != nil || sequence != 1 {
			return fmt.Errorf("%s must be 1", field)
		}
	}
	principal, err := approvalObject(value["approvingPrincipal"], "approvingPrincipal")
	if err != nil {
		return err
	}
	principalKind, err := approvalString(principal["kind"], "approvingPrincipal.kind")
	if err != nil {
		return err
	}
	if principalKind == "local" {
		if err := approvalExactKeys(principal, []string{"kind", "stableId"}); err != nil || principal["stableId"] != "local" {
			return fmt.Errorf("local approving principal is not exact")
		}
	} else if principalKind == "remote_device" {
		if err := approvalExactKeys(principal, []string{"kind", "stableId", "peerFingerprint", "trustEpoch"}); err != nil {
			return err
		}
		stableID, err := approvalString(principal["stableId"], "approvingPrincipal.stableId")
		if err != nil || len(stableID) > 128 || !principalStableIDPattern.MatchString(stableID) {
			return fmt.Errorf("remote approving principal stable ID is invalid")
		}
		if _, err := approvalB64(principal["peerFingerprint"], 16, "peerFingerprint"); err != nil {
			return err
		}
		if _, err := approvalUint64(principal["trustEpoch"], "principal trust epoch"); err != nil {
			return err
		}
	} else {
		return fmt.Errorf("approval principal kind is not closed V1")
	}
	browser, err := approvalObject(value["browserBinding"], "browserBinding")
	if err != nil {
		return err
	}
	browserKind, err := approvalString(browser["kind"], "browserBinding.kind")
	if err != nil {
		return err
	}
	if browserKind == "local" {
		if err := approvalExactKeys(browser, []string{"kind", "hostServerLaunchId", "browserSessionId"}); err != nil {
			return err
		}
		if _, err := approvalB64(browser["hostServerLaunchId"], 32, "hostServerLaunchId"); err != nil {
			return err
		}
	} else if browserKind == "remote" {
		if err := approvalExactKeys(browser, []string{"kind", "gatewayLaunchId", "browserSessionId"}); err != nil {
			return err
		}
		if _, err := approvalB64(browser["gatewayLaunchId"], 32, "gatewayLaunchId"); err != nil {
			return err
		}
	} else {
		return fmt.Errorf("approval browser binding kind is not closed V1")
	}
	if _, err := approvalB64(browser["browserSessionId"], 32, "browserSessionId"); err != nil {
		return err
	}
	if principalKind == "local" && browserKind != "local" || principalKind == "remote_device" && browserKind != "remote" {
		return fmt.Errorf("approval browser binding does not match principal source")
	}
	method, err := approvalString(value["confirmationMethod"], "confirmationMethod")
	if err != nil || method != "GET" && method != "HEAD" && method != "POST" && method != "PUT" && method != "PATCH" && method != "DELETE" {
		return fmt.Errorf("approval confirmation method is not closed V1")
	}
	target, err := approvalString(value["confirmationTarget"], "confirmationTarget")
	if err != nil || !isCanonicalTarget(target) {
		return fmt.Errorf("approval confirmation target is not canonical")
	}
	action, err := approvalString(value["action"], "action")
	if err != nil || action != "approve_pair" {
		return fmt.Errorf("approval action must be approve_pair")
	}
	if assistantValue, ok := value["assistantProvenance"]; ok {
		assistant, err := approvalObject(assistantValue, "assistantProvenance")
		if err != nil {
			return err
		}
		if err := approvalExactKeys(assistant, []string{"conversationId", "confirmedActionPayloadHash"}, "toolCallId", "pendingActionId"); err != nil {
			return err
		}
		for _, field := range []string{"conversationId", "toolCallId", "pendingActionId"} {
			if candidate, ok := assistant[field]; ok {
				text, err := approvalString(candidate, field)
				if err != nil || len(text) > 128 || !approvalIdentifierPattern.MatchString(text) {
					return fmt.Errorf("assistant provenance %s is invalid", field)
				}
			}
		}
		if _, err := approvalB64(assistant["confirmedActionPayloadHash"], 32, "confirmedActionPayloadHash"); err != nil {
			return err
		}
	}
	return nil
}

func ApprovalContextHash(value any) ([]byte, []byte, error) {
	if err := ValidateApprovalReceiptV1(value); err != nil {
		return nil, nil, err
	}
	canonical, err := CanonicalJSONV1(value)
	if err != nil {
		return nil, nil, err
	}
	return canonical, Hash([]byte("waifus/approval-receipt/v1"), canonical), nil
}
