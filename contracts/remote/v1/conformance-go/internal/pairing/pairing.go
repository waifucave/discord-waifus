package pairing

import (
	"bytes"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/flynn/noise"
	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"
)

const (
	FullTokenPrefix    = "WF1."
	NoiseXXPattern     = "Noise_XX_25519_ChaChaPoly_SHA256"
	NoiseXXPSK0Pattern = "Noise_XXpsk0_25519_ChaChaPoly_SHA256"
	identityDomain     = "waifus/identity-bundle/v1"
	fullTokenDomain    = "waifus/full-token/v1"
	installFingerprint = "waifus/install/fingerprint/v1"
	MailboxMessageMax  = 1200
)

var (
	deviceIDPattern   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$`)
	capabilityPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.v(?:0|[1-9][0-9]*)$`)
)

var requiredCapabilities = []string{
	"waifus.browser-context.v1",
	"waifus.dashboard.manifest.v1",
	"waifus.http.v1",
	"waifus.principal.v1",
	"waifus.sse.cursor.v1",
	"waifus.stream.cancel.v1",
}

func RequiredCapabilities() []string {
	return append([]string(nil), requiredCapabilities...)
}

func Sequence(start, length int) []byte {
	if start < 0 || start+length > 256 {
		panic("fixture sequence exceeds one byte")
	}
	result := make([]byte, length)
	for index := range result {
		result[index] = byte(start + index)
	}
	return result
}

func B64(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

func DecodeB64(value string) ([]byte, error) {
	if strings.Contains(value, "=") || value == "" {
		return nil, fmt.Errorf("noncanonical base64url")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || B64(decoded) != value {
		return nil, fmt.Errorf("noncanonical base64url")
	}
	return decoded, nil
}

func Hash(values ...[]byte) []byte {
	hash := sha256.New()
	for _, value := range values {
		hash.Write(value)
	}
	return hash.Sum(nil)
}

func HKDF(input, salt, info []byte, length int) ([]byte, error) {
	reader := hkdf.New(sha256.New, input, salt, info)
	result := make([]byte, length)
	if _, err := io.ReadFull(reader, result); err != nil {
		return nil, err
	}
	return result, nil
}

func X25519Public(private []byte) ([]byte, error) {
	if len(private) != 32 {
		return nil, fmt.Errorf("X25519 private key must be 32 bytes")
	}
	return curve25519.X25519(private, curve25519.Basepoint)
}

func Ed25519Public(seed []byte) ([]byte, error) {
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("Ed25519 seed must be 32 bytes")
	}
	private := ed25519.NewKeyFromSeed(seed)
	return append([]byte(nil), private.Public().(ed25519.PublicKey)...), nil
}

func InstallationFingerprint(public []byte) ([]byte, error) {
	if len(public) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("installation public key must be 32 bytes")
	}
	return Hash([]byte(installFingerprint), public)[:16], nil
}

type FullToken struct {
	InvitationID              []byte
	Expiry                    uint64
	HostInstallationPublicKey []byte
	Fingerprint               []byte
	HostPairingPublicKey      []byte
	FullSecret                []byte
	Signature                 []byte
	UnsignedCBOR              []byte
	EncodedCBOR               []byte
	Encoded                   string
	PSK                       []byte
}

func fullTokenUnsignedMap(token *FullToken) map[uint64]any {
	return map[uint64]any{
		1: uint64(1),
		2: token.InvitationID,
		3: token.Expiry,
		4: token.HostInstallationPublicKey,
		5: token.Fingerprint,
		6: token.HostPairingPublicKey,
		7: token.FullSecret,
	}
}

func CreateFullToken(invitationID []byte, expiry uint64, installationSeed, hostPairingPublic, fullSecret []byte) (*FullToken, error) {
	if len(invitationID) != 16 || len(hostPairingPublic) != 32 || len(fullSecret) != 32 {
		return nil, fmt.Errorf("full token field has wrong width")
	}
	public, err := Ed25519Public(installationSeed)
	if err != nil {
		return nil, err
	}
	fingerprint, err := InstallationFingerprint(public)
	if err != nil {
		return nil, err
	}
	token := &FullToken{
		InvitationID:              append([]byte(nil), invitationID...),
		Expiry:                    expiry,
		HostInstallationPublicKey: public,
		Fingerprint:               fingerprint,
		HostPairingPublicKey:      append([]byte(nil), hostPairingPublic...),
		FullSecret:                append([]byte(nil), fullSecret...),
	}
	token.UnsignedCBOR, err = EncodeCanonicalCBOR(fullTokenUnsignedMap(token))
	if err != nil {
		return nil, err
	}
	private := ed25519.NewKeyFromSeed(installationSeed)
	token.Signature = ed25519.Sign(private, append([]byte(fullTokenDomain), token.UnsignedCBOR...))
	signedMap := fullTokenUnsignedMap(token)
	signedMap[8] = token.Signature
	token.EncodedCBOR, err = EncodeCanonicalCBOR(signedMap)
	if err != nil {
		return nil, err
	}
	token.Encoded = FullTokenPrefix + B64(token.EncodedCBOR)
	token.PSK, err = HKDF(token.FullSecret, token.InvitationID, []byte("waifus-noise-xxpsk0-v1"), 32)
	return token, err
}

func exactKeys(value map[uint64]any, maximum uint64) bool {
	if len(value) != int(maximum) {
		return false
	}
	for key := uint64(1); key <= maximum; key++ {
		if _, ok := value[key]; !ok {
			return false
		}
	}
	return true
}

func uintField(value map[uint64]any, key uint64) (uint64, error) {
	field, ok := value[key].(uint64)
	if !ok {
		return 0, fmt.Errorf("field %d is not unsigned integer", key)
	}
	return field, nil
}

func bytesField(value map[uint64]any, key uint64, length int) ([]byte, error) {
	field, ok := value[key].([]byte)
	if !ok || len(field) != length {
		return nil, fmt.Errorf("field %d is not %d-byte string", key, length)
	}
	return field, nil
}

func DecodeFullToken(encoded string, now uint64) (*FullToken, error) {
	if !strings.HasPrefix(encoded, FullTokenPrefix) || len(encoded) > 1024 {
		return nil, fmt.Errorf("wrong token prefix or size")
	}
	encodedCBOR, err := DecodeB64(strings.TrimPrefix(encoded, FullTokenPrefix))
	if err != nil {
		return nil, err
	}
	decoded, err := DecodeCanonicalCBOR(encodedCBOR)
	if err != nil {
		return nil, err
	}
	value, ok := decoded.(map[uint64]any)
	if !ok || !exactKeys(value, 8) {
		return nil, fmt.Errorf("token fields are not exact")
	}
	version, err := uintField(value, 1)
	if err != nil || version != 1 {
		return nil, fmt.Errorf("unsupported token version")
	}
	invitationID, err := bytesField(value, 2, 16)
	if err != nil {
		return nil, err
	}
	expiry, err := uintField(value, 3)
	if err != nil {
		return nil, err
	}
	public, err := bytesField(value, 4, 32)
	if err != nil {
		return nil, err
	}
	fingerprint, err := bytesField(value, 5, 16)
	if err != nil {
		return nil, err
	}
	pairingPublic, err := bytesField(value, 6, 32)
	if err != nil {
		return nil, err
	}
	secret, err := bytesField(value, 7, 32)
	if err != nil {
		return nil, err
	}
	signature, err := bytesField(value, 8, 64)
	if err != nil {
		return nil, err
	}
	expectedFingerprint, _ := InstallationFingerprint(public)
	if !hmac.Equal(fingerprint, expectedFingerprint) {
		return nil, fmt.Errorf("invalid token fingerprint")
	}
	token := &FullToken{
		InvitationID: invitationID, Expiry: expiry, HostInstallationPublicKey: public,
		Fingerprint: fingerprint, HostPairingPublicKey: pairingPublic, FullSecret: secret,
		Signature: signature, EncodedCBOR: encodedCBOR, Encoded: encoded,
	}
	token.UnsignedCBOR, err = EncodeCanonicalCBOR(fullTokenUnsignedMap(token))
	if err != nil {
		return nil, err
	}
	if !ed25519.Verify(public, append([]byte(fullTokenDomain), token.UnsignedCBOR...), signature) {
		return nil, fmt.Errorf("invalid token signature")
	}
	if expiry <= now {
		return nil, fmt.Errorf("token expired")
	}
	token.PSK, err = HKDF(secret, invitationID, []byte("waifus-noise-xxpsk0-v1"), 32)
	return token, err
}

type Protocol struct {
	Major uint64
	Minor uint64
}

type Identity struct {
	Version               uint64
	DeviceID              string
	Role                  uint64
	TrustEpoch            uint64
	InstallationPublicKey []byte
	NodePublicKey         []byte
	DiscoveryPublicKey    []byte
	KeySequence           uint64
	Protocol              Protocol
	RequiredCapabilities  []string
	OptionalCapabilities  []string
	Signature             []byte
	UnsignedCBOR          []byte
	BundleCBOR            []byte
	BundleHash            []byte
}

func identityUnsignedMap(identity *Identity) map[uint64]any {
	return map[uint64]any{
		1:  identity.Version,
		2:  identity.DeviceID,
		3:  identity.Role,
		4:  identity.TrustEpoch,
		5:  identity.InstallationPublicKey,
		6:  identity.NodePublicKey,
		7:  identity.DiscoveryPublicKey,
		8:  identity.KeySequence,
		9:  map[uint64]any{1: identity.Protocol.Major, 2: identity.Protocol.Minor},
		10: map[uint64]any{1: identity.RequiredCapabilities, 2: identity.OptionalCapabilities},
	}
}

func CreateIdentity(role uint64, installationSeed, nodePrivate, discoveryPrivate []byte) (*Identity, error) {
	installationPublic, err := Ed25519Public(installationSeed)
	if err != nil {
		return nil, err
	}
	nodePublic, err := X25519Public(nodePrivate)
	if err != nil {
		return nil, err
	}
	discoveryPublic, err := X25519Public(discoveryPrivate)
	if err != nil {
		return nil, err
	}
	if role != 1 && role != 2 {
		return nil, fmt.Errorf("invalid identity role")
	}
	identity := &Identity{
		Version: 1, Role: role, TrustEpoch: role, KeySequence: 1,
		DeviceID:              map[uint64]string{1: "host-device-01", 2: "remote-device-01"}[role],
		InstallationPublicKey: installationPublic,
		NodePublicKey:         nodePublic,
		DiscoveryPublicKey:    discoveryPublic,
		Protocol:              Protocol{Major: 1, Minor: 0},
		RequiredCapabilities:  RequiredCapabilities(),
		OptionalCapabilities:  []string{},
	}
	identity.UnsignedCBOR, err = EncodeCanonicalCBOR(identityUnsignedMap(identity))
	if err != nil {
		return nil, err
	}
	identity.Signature = ed25519.Sign(
		ed25519.NewKeyFromSeed(installationSeed),
		append([]byte(identityDomain), identity.UnsignedCBOR...),
	)
	signedMap := identityUnsignedMap(identity)
	signedMap[11] = identity.Signature
	identity.BundleCBOR, err = EncodeCanonicalCBOR(signedMap)
	if err != nil {
		return nil, err
	}
	identity.BundleHash = Hash(identity.BundleCBOR)
	return identity, nil
}

func textField(value map[uint64]any, key uint64) (string, error) {
	field, ok := value[key].(string)
	if !ok {
		return "", fmt.Errorf("field %d is not text", key)
	}
	return field, nil
}

func stringListField(value map[uint64]any, key uint64) ([]string, error) {
	field, ok := value[key].([]any)
	if !ok {
		return nil, fmt.Errorf("field %d is not array", key)
	}
	result := make([]string, len(field))
	for index, item := range field {
		text, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("field %d contains non-text", key)
		}
		result[index] = text
	}
	return result, nil
}

func validCapabilityList(values []string) bool {
	if len(values) > 128 {
		return false
	}
	for index, value := range values {
		if len(value) == 0 || len(value) > 96 || !capabilityPattern.MatchString(value) {
			return false
		}
		if index > 0 && values[index-1] >= value {
			return false
		}
	}
	return true
}

func validCapabilitySet(required, optional []string) bool {
	if !validCapabilityList(required) || !validCapabilityList(optional) {
		return false
	}
	requiredSet := make(map[string]struct{}, len(required))
	for _, capability := range required {
		requiredSet[capability] = struct{}{}
	}
	for _, capability := range optional {
		if _, exists := requiredSet[capability]; exists {
			return false
		}
	}
	return true
}

func DecodeIdentity(encoded []byte) (*Identity, error) {
	if len(encoded) > 1200 {
		return nil, fmt.Errorf("identity exceeds 1200 bytes")
	}
	decoded, err := DecodeCanonicalCBOR(encoded)
	if err != nil {
		return nil, err
	}
	value, ok := decoded.(map[uint64]any)
	if !ok || !exactKeys(value, 11) {
		return nil, fmt.Errorf("identity fields are not exact")
	}
	protocol, ok := value[9].(map[uint64]any)
	if !ok || !exactKeys(protocol, 2) {
		return nil, fmt.Errorf("identity protocol fields are not exact")
	}
	capabilities, ok := value[10].(map[uint64]any)
	if !ok || !exactKeys(capabilities, 2) {
		return nil, fmt.Errorf("identity capability fields are not exact")
	}
	identity := &Identity{BundleCBOR: append([]byte(nil), encoded...)}
	identity.Version, err = uintField(value, 1)
	if err != nil || identity.Version != 1 {
		return nil, fmt.Errorf("unsupported identity version")
	}
	identity.DeviceID, err = textField(value, 2)
	if err != nil || !deviceIDPattern.MatchString(identity.DeviceID) {
		return nil, fmt.Errorf("invalid device ID")
	}
	identity.Role, err = uintField(value, 3)
	if err != nil || (identity.Role != 1 && identity.Role != 2) {
		return nil, fmt.Errorf("invalid identity role")
	}
	identity.TrustEpoch, err = uintField(value, 4)
	if err != nil {
		return nil, fmt.Errorf("invalid trust epoch")
	}
	identity.InstallationPublicKey, err = bytesField(value, 5, 32)
	if err != nil {
		return nil, err
	}
	identity.NodePublicKey, err = bytesField(value, 6, 32)
	if err != nil {
		return nil, err
	}
	identity.DiscoveryPublicKey, err = bytesField(value, 7, 32)
	if err != nil {
		return nil, err
	}
	identity.KeySequence, err = uintField(value, 8)
	if err != nil || identity.KeySequence != 1 {
		return nil, fmt.Errorf("invalid key sequence")
	}
	identity.Protocol.Major, err = uintField(protocol, 1)
	if err != nil {
		return nil, err
	}
	identity.Protocol.Minor, err = uintField(protocol, 2)
	if err != nil {
		return nil, err
	}
	if identity.Protocol.Major > 65535 || identity.Protocol.Minor > 65535 {
		return nil, fmt.Errorf("identity protocol version exceeds uint16")
	}
	identity.RequiredCapabilities, err = stringListField(capabilities, 1)
	if err != nil {
		return nil, err
	}
	identity.OptionalCapabilities, err = stringListField(capabilities, 2)
	if err != nil {
		return nil, err
	}
	if !validCapabilitySet(identity.RequiredCapabilities, identity.OptionalCapabilities) {
		return nil, fmt.Errorf("invalid identity capability set")
	}
	identity.Signature, err = bytesField(value, 11, 64)
	if err != nil {
		return nil, err
	}
	identity.UnsignedCBOR, err = EncodeCanonicalCBOR(identityUnsignedMap(identity))
	if err != nil {
		return nil, err
	}
	if !ed25519.Verify(
		identity.InstallationPublicKey,
		append([]byte(identityDomain), identity.UnsignedCBOR...),
		identity.Signature,
	) {
		return nil, fmt.Errorf("invalid identity signature")
	}
	identity.BundleHash = Hash(identity.BundleCBOR)
	return identity, nil
}

func NoisePrologue(invitationID []byte, generation uint64, pairID []byte) ([]byte, error) {
	if len(invitationID) != 16 || len(pairID) != 16 {
		return nil, fmt.Errorf("invitation and pair IDs must be 16 bytes")
	}
	protocol := make([]byte, 4)
	binary.BigEndian.PutUint16(protocol[0:2], 1)
	binary.BigEndian.PutUint16(protocol[2:4], 0)
	generationBytes := make([]byte, 8)
	binary.BigEndian.PutUint64(generationBytes, generation)
	return bytes.Join([][]byte{
		[]byte("WAIFUS-PAIR"), {0}, protocol, invitationID, generationBytes, pairID, {2, 1},
	}, nil), nil
}

func LP(value []byte) []byte {
	encoded := make([]byte, 4+len(value))
	binary.BigEndian.PutUint32(encoded, uint32(len(value)))
	copy(encoded[4:], value)
	return encoded
}

type NoiseResult struct {
	Pattern                          string
	Messages                         [][]byte
	ChannelBinding                   []byte
	TranscriptHash                   []byte
	InitiatorToResponderTransportKey []byte
	ResponderToInitiatorTransportKey []byte
	RemoteContributionCiphertext     []byte
	HostContributionCiphertext       []byte
}

func noiseKey(private []byte) (noise.DHKey, error) {
	public, err := X25519Public(private)
	if err != nil {
		return noise.DHKey{}, err
	}
	return noise.DHKey{Private: append([]byte(nil), private...), Public: public}, nil
}

func checkNoiseMessageSize(message []byte) error {
	if len(message) > MailboxMessageMax {
		return fmt.Errorf("Noise handshake message exceeds %d-byte mailbox limit", MailboxMessageMax)
	}
	return nil
}

func RunNoiseXX(
	prologue, psk, initiatorStaticPrivate, responderStaticPrivate,
	initiatorEphemeralPrivate, responderEphemeralPrivate []byte,
	payloads [][]byte,
	remoteContribution, hostContribution []byte,
) (*NoiseResult, error) {
	if len(payloads) != 3 {
		return nil, fmt.Errorf("Noise XX requires three payloads")
	}
	initiatorStatic, err := noiseKey(initiatorStaticPrivate)
	if err != nil {
		return nil, err
	}
	responderStatic, err := noiseKey(responderStaticPrivate)
	if err != nil {
		return nil, err
	}
	cipherSuite := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256)
	initiatorConfig := noise.Config{
		CipherSuite: cipherSuite, Pattern: noise.HandshakeXX, Initiator: true,
		Prologue: prologue, StaticKeypair: initiatorStatic,
		Random: bytes.NewReader(initiatorEphemeralPrivate),
	}
	responderConfig := noise.Config{
		CipherSuite: cipherSuite, Pattern: noise.HandshakeXX,
		Prologue: prologue, StaticKeypair: responderStatic,
		Random: bytes.NewReader(responderEphemeralPrivate),
	}
	pattern := NoiseXXPattern
	if psk != nil {
		if len(psk) != 32 {
			return nil, fmt.Errorf("Noise PSK must be 32 bytes")
		}
		initiatorConfig.PresharedKey = psk
		responderConfig.PresharedKey = psk
		pattern = NoiseXXPSK0Pattern
	}
	initiator, err := noise.NewHandshakeState(initiatorConfig)
	if err != nil {
		return nil, err
	}
	responder, err := noise.NewHandshakeState(responderConfig)
	if err != nil {
		return nil, err
	}
	first, _, _, err := initiator.WriteMessage(nil, payloads[0])
	if err != nil {
		return nil, err
	}
	if err := checkNoiseMessageSize(first); err != nil {
		return nil, err
	}
	decoded, _, _, err := responder.ReadMessage(nil, first)
	if err != nil {
		return nil, fmt.Errorf("read Noise first payload: %w", err)
	}
	if !bytes.Equal(decoded, payloads[0]) {
		return nil, fmt.Errorf("Noise first payload mismatch")
	}
	second, _, _, err := responder.WriteMessage(nil, payloads[1])
	if err != nil {
		return nil, err
	}
	if err := checkNoiseMessageSize(second); err != nil {
		return nil, err
	}
	decoded, _, _, err = initiator.ReadMessage(nil, second)
	if err != nil {
		return nil, fmt.Errorf("read Noise second payload: %w", err)
	}
	if !bytes.Equal(decoded, payloads[1]) {
		return nil, fmt.Errorf("Noise second payload mismatch")
	}
	third, initiatorFirst, initiatorSecond, err := initiator.WriteMessage(nil, payloads[2])
	if err != nil {
		return nil, err
	}
	if err := checkNoiseMessageSize(third); err != nil {
		return nil, err
	}
	decoded, responderFirst, responderSecond, err := responder.ReadMessage(nil, third)
	if err != nil {
		return nil, fmt.Errorf("read Noise third payload: %w", err)
	}
	if !bytes.Equal(decoded, payloads[2]) {
		return nil, fmt.Errorf("Noise third payload mismatch")
	}
	channelBinding := initiator.ChannelBinding()
	if !bytes.Equal(channelBinding, responder.ChannelBinding()) {
		return nil, fmt.Errorf("Noise channel binding mismatch")
	}
	initiatorFirstKey := initiatorFirst.UnsafeKey()
	initiatorSecondKey := initiatorSecond.UnsafeKey()
	responderFirstKey := responderFirst.UnsafeKey()
	responderSecondKey := responderSecond.UnsafeKey()
	if initiatorFirstKey != responderFirstKey || initiatorSecondKey != responderSecondKey {
		return nil, fmt.Errorf("Noise transport key mismatch")
	}
	remoteCiphertext, err := initiatorFirst.Encrypt(nil, nil, remoteContribution)
	if err != nil {
		return nil, err
	}
	plaintext, err := responderFirst.Decrypt(nil, nil, remoteCiphertext)
	if err != nil {
		return nil, fmt.Errorf("decrypt remote contribution: %w", err)
	}
	if !bytes.Equal(plaintext, remoteContribution) {
		return nil, fmt.Errorf("remote contribution transport mismatch")
	}
	hostCiphertext, err := responderSecond.Encrypt(nil, nil, hostContribution)
	if err != nil {
		return nil, err
	}
	plaintext, err = initiatorSecond.Decrypt(nil, nil, hostCiphertext)
	if err != nil {
		return nil, fmt.Errorf("decrypt host contribution: %w", err)
	}
	if !bytes.Equal(plaintext, hostContribution) {
		return nil, fmt.Errorf("host contribution transport mismatch")
	}
	messages := [][]byte{first, second, third}
	transcriptInput := make([]byte, 0)
	for _, message := range messages {
		transcriptInput = append(transcriptInput, LP(message)...)
	}
	return &NoiseResult{
		Pattern: pattern, Messages: messages, ChannelBinding: append([]byte(nil), channelBinding...),
		TranscriptHash:                   Hash(transcriptInput),
		InitiatorToResponderTransportKey: append([]byte(nil), initiatorFirstKey[:]...),
		ResponderToInitiatorTransportKey: append([]byte(nil), initiatorSecondKey[:]...),
		RemoteContributionCiphertext:     remoteCiphertext, HostContributionCiphertext: hostCiphertext,
	}, nil
}

type PairKeys struct {
	PairRoot                    []byte
	PairKeySalt                 []byte
	CoordinationHostToRemoteKey []byte
	CoordinationRemoteToHostKey []byte
	ConfirmationKey             []byte
	RevocationKey               []byte
}

func DerivePairKeys(
	hostContribution, remoteContribution, channelBinding, invitationID []byte,
	generation uint64, pairID, hostBundleHash, remoteBundleHash,
	hostInstallationPublicKey, remoteInstallationPublicKey []byte,
) (*PairKeys, error) {
	if len(hostContribution) != 32 || len(remoteContribution) != 32 || len(channelBinding) != 32 ||
		len(invitationID) != 16 || len(pairID) != 16 || len(hostBundleHash) != 32 || len(remoteBundleHash) != 32 ||
		len(hostInstallationPublicKey) != 32 || len(remoteInstallationPublicKey) != 32 {
		return nil, fmt.Errorf("pair derivation field has wrong width")
	}
	if hmac.Equal(hostBundleHash, remoteBundleHash) || hmac.Equal(hostInstallationPublicKey, remoteInstallationPublicKey) {
		return nil, fmt.Errorf("self-pair installation identity matches")
	}
	generationBytes := make([]byte, 8)
	binary.BigEndian.PutUint64(generationBytes, generation)
	context := bytes.Join([][]byte{invitationID, generationBytes, pairID, hostBundleHash, remoteBundleHash}, nil)
	pairRoot, err := HKDF(
		append(append([]byte(nil), hostContribution...), remoteContribution...),
		channelBinding,
		bytes.Join([][]byte{[]byte("waifus-pair-root-v1"), {0}, context}, nil),
		32,
	)
	if err != nil {
		return nil, err
	}
	pairKeySalt := Hash([]byte("waifus/pair-key-salt/v1"), []byte{0}, channelBinding, pairID)
	derive := func(label string) ([]byte, error) {
		return HKDF(
			pairRoot,
			pairKeySalt,
			bytes.Join([][]byte{[]byte(label), {0}, context}, nil),
			32,
		)
	}
	keys := &PairKeys{PairRoot: pairRoot, PairKeySalt: pairKeySalt}
	keys.CoordinationHostToRemoteKey, err = derive("waifus-coordination-host-to-remote-v1")
	if err != nil {
		return nil, err
	}
	keys.CoordinationRemoteToHostKey, err = derive("waifus-coordination-remote-to-host-v1")
	if err != nil {
		return nil, err
	}
	keys.ConfirmationKey, err = derive("waifus-confirmation-v1")
	if err != nil {
		return nil, err
	}
	keys.RevocationKey, err = derive("waifus-revocation-v1")
	return keys, err
}

type SAS struct {
	CanonicalIdentityBundleHash []byte
	Bytes                       []byte
	Indices                     [5]uint16
	Words                       [5]string
	Fingerprint                 string
}

func DeriveSAS(channelBinding, pairID, hostBundle, remoteBundle []byte) (*SAS, error) {
	host, err := DecodeIdentity(hostBundle)
	if err != nil {
		return nil, err
	}
	remote, err := DecodeIdentity(remoteBundle)
	if err != nil {
		return nil, err
	}
	if host.Role != 1 || remote.Role != 2 || hmac.Equal(host.InstallationPublicKey, remote.InstallationPublicKey) {
		return nil, fmt.Errorf("invalid SAS identity order or self-pair")
	}
	if len(channelBinding) != 32 || len(pairID) != 16 {
		return nil, fmt.Errorf("invalid SAS context width")
	}
	identityHash := Hash(hostBundle, remoteBundle)
	sasBytes, err := HKDF(channelBinding, pairID, append([]byte("waifus/sas/v1"), identityHash...), 7)
	if err != nil {
		return nil, err
	}
	bits := uint64(0)
	for _, value := range sasBytes {
		bits = bits<<8 | uint64(value)
	}
	bits >>= 6
	indices := [5]uint16{}
	for index := range indices {
		indices[index] = uint16((bits >> uint((4-index)*10)) & 0x3ff)
	}
	words, err := MapSASIndicesToWordsV1(indices)
	if err != nil {
		return nil, err
	}
	fingerprint := Hash([]byte("waifus/sas-fingerprint/v1"), pairID, channelBinding, identityHash)[:6]
	return &SAS{
		CanonicalIdentityBundleHash: identityHash,
		Bytes:                       sasBytes,
		Indices:                     indices,
		Words:                       words,
		Fingerprint:                 fmt.Sprintf("%x", fingerprint),
	}, nil
}
