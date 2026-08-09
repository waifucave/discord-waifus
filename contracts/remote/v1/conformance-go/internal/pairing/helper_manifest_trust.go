package pairing

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	HelperManifestMaxBytes      = 32768
	HelperReleaseSignatureBytes = 64
	HelperReleaseTrustMaxKeys   = 8
)

const helperReleaseKeyFingerprintDomain = "waifus/helper-release-key/v1"

var (
	helperReleaseKeyIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,95}$`)
	helperUint64Pattern       = regexp.MustCompile(`^(?:0|[1-9][0-9]{0,19})$`)
	helperSHA256Pattern       = regexp.MustCompile(`^[0-9a-f]{64}$`)
	helperGitSHA1Pattern      = regexp.MustCompile(`^[0-9a-f]{40}$`)
	helperReleasedAtPattern   = regexp.MustCompile(`^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$`)
	helperCapabilityPattern   = regexp.MustCompile(`^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.v(?:0|[1-9][0-9]*)$`)
	helperSemVerPattern       = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)
)

type HelperManifestTrustError struct {
	Code   string
	Detail string
}

func (e *HelperManifestTrustError) Error() string {
	return e.Code + ": " + e.Detail
}

func helperManifestFailure(code, detail string) error {
	return &HelperManifestTrustError{Code: code, Detail: detail}
}

func HelperManifestTrustErrorCode(err error) string {
	if value, ok := err.(*HelperManifestTrustError); ok {
		return value.Code
	}
	return ""
}

type HelperReleaseTrustEntryV1 struct {
	KeyID             string `json:"keyId"`
	PublicKeyB64      string `json:"publicKeyB64"`
	Fingerprint       string `json:"fingerprint"`
	SequenceFrom      string `json:"sequenceFrom"`
	SequenceThrough   string `json:"sequenceThrough"`
	ReleasedAtFrom    string `json:"releasedAtFrom"`
	ReleasedAtThrough string `json:"releasedAtThrough"`
}

type HelperTargetV1 struct {
	OS    string `json:"os"`
	Arch  string `json:"arch"`
	Goarm *uint8 `json:"goarm,omitempty"`
}

type HelperProtocolRangeV1 struct {
	Major        uint16 `json:"major"`
	MinimumMinor uint16 `json:"minimumMinor"`
	MaximumMinor uint16 `json:"maximumMinor"`
}

type HelperProtocolsV1 struct {
	IPC            HelperProtocolRangeV1 `json:"ipc"`
	Coordination   HelperProtocolRangeV1 `json:"coordination"`
	DirectService  HelperProtocolRangeV1 `json:"directService"`
	HelperManifest HelperProtocolRangeV1 `json:"helperManifest"`
}

type HelperBinaryV1 struct {
	RelativePath string `json:"relativePath"`
	ByteSize     string `json:"byteSize"`
	SHA256       string `json:"sha256"`
}

type HelperTailscaleV1 struct {
	Tag    string `json:"tag"`
	Commit string `json:"commit"`
}

type HelperManifestV1 struct {
	SchemaVersion                        uint8             `json:"schemaVersion"`
	HelperVersion                        string            `json:"helperVersion"`
	ReleaseSequence                      string            `json:"releaseSequence"`
	ReleasedAt                           string            `json:"releasedAt"`
	PackageName                          string            `json:"packageName"`
	Target                               HelperTargetV1    `json:"target"`
	Binary                               HelperBinaryV1    `json:"binary"`
	Protocols                            HelperProtocolsV1 `json:"protocols"`
	Capabilities                         []string          `json:"capabilities"`
	MinimumDiscordWaifusVersion          string            `json:"minimumDiscordWaifusVersion"`
	MaximumDiscordWaifusVersionExclusive string            `json:"maximumDiscordWaifusVersionExclusive"`
	SourceCommit                         string            `json:"sourceCommit"`
	ContractCommit                       string            `json:"contractCommit"`
	ForkCommit                           string            `json:"forkCommit"`
	WorkerTrustRingSHA256                string            `json:"workerTrustRingSha256"`
	Tailscale                            HelperTailscaleV1 `json:"tailscale"`
	GoVersion                            string            `json:"goVersion"`
	DirectOnlyBuildTag                   string            `json:"directOnlyBuildTag"`
	OSSNoticeSHA256                      string            `json:"ossNoticeSha256"`
	ReleaseKeyIDs                        []string          `json:"releaseKeyIds"`
}

type HelperManifestExpectedV1 struct {
	PackageName           string            `json:"packageName"`
	Target                HelperTargetV1    `json:"target"`
	AppVersion            string            `json:"appVersion"`
	PinnedHelperVersion   string            `json:"pinnedHelperVersion"`
	MinimumReleaseSeq     string            `json:"minimumReleaseSequence"`
	WorkerTrustRingSHA256 string            `json:"workerTrustRingSha256"`
	Protocols             HelperProtocolsV1 `json:"protocols"`
	Capabilities          []string          `json:"capabilities"`
}

type HelperManifestTrustInputV1 struct {
	ManifestBytes     []byte
	Signatures        map[string][]byte
	TrustEntries      []HelperReleaseTrustEntryV1
	BinaryBytes       []byte
	NoticesBytes      []byte
	Expected          HelperManifestExpectedV1
	EmbeddedBuildInfo any
}

type VerifiedHelperManifestV1 struct {
	Manifest              HelperManifestV1
	ManifestBytes         []byte
	VerifiedReleaseKeyIDs []string
}

type validatedHelperReleaseTrustEntry struct {
	Value           HelperReleaseTrustEntryV1
	PublicKey       []byte
	SequenceFrom    uint64
	SequenceThrough uint64
}

func strictDecodeJSON(payload []byte, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("extra JSON value")
		}
		return err
	}
	return nil
}

func decodeGenericJSON(payload []byte) (any, error) {
	if !utf8.Valid(payload) {
		return nil, fmt.Errorf("invalid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("extra JSON value")
		}
		return nil, err
	}
	return value, nil
}

func parseHelperUint64(value, name string, positive bool) (uint64, error) {
	if !helperUint64Pattern.MatchString(value) {
		return 0, fmt.Errorf("%s is not canonical uint64 decimal", name)
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || strconv.FormatUint(parsed, 10) != value || (positive && parsed == 0) {
		return 0, fmt.Errorf("%s is outside its canonical uint64 range", name)
	}
	return parsed, nil
}

func validHelperReleasedAt(value string) bool {
	if len(value) != 20 || !helperReleasedAtPattern.MatchString(value) {
		return false
	}
	parsed, err := time.Parse(time.RFC3339, value)
	return err == nil && parsed.UTC().Format(time.RFC3339) == value
}

func decodeCanonicalHelperB64(value string, length int) ([]byte, error) {
	if value == "" || strings.Contains(value, "=") {
		return nil, fmt.Errorf("not canonical base64url")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != length || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return nil, fmt.Errorf("not canonical %d-byte base64url", length)
	}
	return decoded, nil
}

func DeriveHelperReleaseKeyFingerprintV1(keyID string, publicKey []byte) (string, error) {
	if !helperReleaseKeyIDPattern.MatchString(keyID) {
		return "", helperManifestFailure("invalid_trust_ring", "release key ID is not canonical")
	}
	if len(publicKey) != ed25519.PublicKeySize {
		return "", helperManifestFailure("invalid_trust_ring", "release public key must be exactly 32 raw bytes")
	}
	hash := sha256.New()
	hash.Write([]byte(helperReleaseKeyFingerprintDomain))
	hash.Write([]byte{0})
	hash.Write([]byte(keyID))
	hash.Write(publicKey)
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func validateHelperTrustEntries(entries []HelperReleaseTrustEntryV1) (map[string]validatedHelperReleaseTrustEntry, error) {
	if len(entries) < 1 || len(entries) > HelperReleaseTrustMaxKeys {
		return nil, helperManifestFailure("invalid_trust_ring", "release trust ring must contain 1-8 keys")
	}
	result := make(map[string]validatedHelperReleaseTrustEntry, len(entries))
	seenPublicKeys := map[string]bool{}
	previousID := ""
	for index, entry := range entries {
		if !helperReleaseKeyIDPattern.MatchString(entry.KeyID) || (index > 0 && previousID >= entry.KeyID) {
			return nil, helperManifestFailure("invalid_trust_ring", "release trust entries must be key-ID sorted")
		}
		previousID = entry.KeyID
		publicKey, err := decodeCanonicalHelperB64(entry.PublicKeyB64, ed25519.PublicKeySize)
		if err != nil {
			return nil, helperManifestFailure("invalid_trust_ring", "release public key is invalid")
		}
		identity := hex.EncodeToString(publicKey)
		if seenPublicKeys[identity] {
			return nil, helperManifestFailure("invalid_trust_ring", "release trust entries cannot reuse a raw public key")
		}
		seenPublicKeys[identity] = true
		fingerprint, err := DeriveHelperReleaseKeyFingerprintV1(entry.KeyID, publicKey)
		if err != nil {
			return nil, err
		}
		if !helperSHA256Pattern.MatchString(entry.Fingerprint) || entry.Fingerprint != fingerprint {
			return nil, helperManifestFailure("invalid_release_key_fingerprint", "release-key fingerprint does not match")
		}
		sequenceFrom, err := parseHelperUint64(entry.SequenceFrom, "release sequence from", true)
		if err != nil {
			return nil, helperManifestFailure("invalid_trust_ring", err.Error())
		}
		sequenceThrough, err := parseHelperUint64(entry.SequenceThrough, "release sequence through", true)
		if err != nil || sequenceFrom > sequenceThrough {
			return nil, helperManifestFailure("invalid_trust_ring", "release-key sequence window is invalid or reversed")
		}
		if !validHelperReleasedAt(entry.ReleasedAtFrom) || !validHelperReleasedAt(entry.ReleasedAtThrough) || entry.ReleasedAtFrom > entry.ReleasedAtThrough {
			return nil, helperManifestFailure("invalid_trust_ring", "release-key signed-time window is invalid or reversed")
		}
		result[entry.KeyID] = validatedHelperReleaseTrustEntry{
			Value: entry, PublicKey: publicKey,
			SequenceFrom: sequenceFrom, SequenceThrough: sequenceThrough,
		}
	}
	return result, nil
}

type helperManifestSelectors struct {
	Parsed          map[string]any
	ReleaseKeyIDs   []string
	ReleaseSequence uint64
	ReleasedAt      string
}

func parseHelperManifestSelectors(payload []byte) (helperManifestSelectors, error) {
	decoded, err := decodeGenericJSON(payload)
	if err != nil {
		return helperManifestSelectors{}, helperManifestFailure("invalid_manifest", "helper manifest is not one bounded UTF-8 JSON value")
	}
	parsed, ok := decoded.(map[string]any)
	if !ok {
		return helperManifestSelectors{}, helperManifestFailure("invalid_manifest", "helper manifest root must be an object")
	}
	rawIDs, ok := parsed["releaseKeyIds"].([]any)
	if !ok || len(rawIDs) < 1 || len(rawIDs) > HelperReleaseTrustMaxKeys {
		return helperManifestSelectors{}, helperManifestFailure("invalid_manifest", "manifest releaseKeyIds are invalid")
	}
	ids := make([]string, len(rawIDs))
	for index, raw := range rawIDs {
		id, ok := raw.(string)
		if !ok || !helperReleaseKeyIDPattern.MatchString(id) || (index > 0 && ids[index-1] >= id) {
			return helperManifestSelectors{}, helperManifestFailure("invalid_manifest", "manifest releaseKeyIds are not canonical and sorted")
		}
		ids[index] = id
	}
	sequenceText, ok := parsed["releaseSequence"].(string)
	if !ok {
		return helperManifestSelectors{}, helperManifestFailure("invalid_manifest", "manifest release sequence selector is missing")
	}
	sequence, err := parseHelperUint64(sequenceText, "manifest release sequence", true)
	if err != nil {
		return helperManifestSelectors{}, helperManifestFailure("invalid_manifest", "manifest release sequence selector is invalid")
	}
	releasedAt, ok := parsed["releasedAt"].(string)
	if !ok || !validHelperReleasedAt(releasedAt) {
		return helperManifestSelectors{}, helperManifestFailure("invalid_manifest", "manifest releasedAt selector is invalid")
	}
	return helperManifestSelectors{Parsed: parsed, ReleaseKeyIDs: ids, ReleaseSequence: sequence, ReleasedAt: releasedAt}, nil
}

func verifyHelperManifestSignatures(payload []byte, selectors helperManifestSelectors, signatures map[string][]byte, trust map[string]validatedHelperReleaseTrustEntry) ([]string, error) {
	declared := make(map[string]bool, len(selectors.ReleaseKeyIDs))
	for _, keyID := range selectors.ReleaseKeyIDs {
		declared[keyID] = true
	}
	for keyID := range signatures {
		if !declared[keyID] {
			return nil, helperManifestFailure("unknown_signature", "signature for an undeclared key is forbidden")
		}
	}
	verified := make([]string, 0, len(selectors.ReleaseKeyIDs))
	for _, keyID := range selectors.ReleaseKeyIDs {
		entry, ok := trust[keyID]
		if !ok {
			return nil, helperManifestFailure("unknown_release_key", "manifest release key is not trusted")
		}
		if selectors.ReleaseSequence < entry.SequenceFrom || selectors.ReleaseSequence > entry.SequenceThrough {
			return nil, helperManifestFailure("key_sequence_out_of_window", "release key does not cover the signed release sequence")
		}
		if selectors.ReleasedAt < entry.Value.ReleasedAtFrom || selectors.ReleasedAt > entry.Value.ReleasedAtThrough {
			return nil, helperManifestFailure("key_time_out_of_window", "release key does not cover the signed release time")
		}
		signature, ok := signatures[keyID]
		if !ok {
			return nil, helperManifestFailure("missing_signature", "manifest is missing a declared overlap signature")
		}
		if len(signature) != HelperReleaseSignatureBytes || !ed25519.Verify(entry.PublicKey, payload, signature) {
			return nil, helperManifestFailure("invalid_signature", "manifest signature is invalid")
		}
		verified = append(verified, keyID)
	}
	return verified, nil
}

func validateHelperProtocolRange(value HelperProtocolRangeV1) bool {
	return value.Major >= 1 && value.MinimumMinor <= value.MaximumMinor
}

func validateHelperProtocols(value HelperProtocolsV1) bool {
	return validateHelperProtocolRange(value.IPC) &&
		validateHelperProtocolRange(value.Coordination) &&
		validateHelperProtocolRange(value.DirectService) &&
		validateHelperProtocolRange(value.HelperManifest)
}

func validateHelperCapabilities(values []string) bool {
	if len(values) > 128 {
		return false
	}
	for index, value := range values {
		if len(value) < 1 || len(value) > 96 || !helperCapabilityPattern.MatchString(value) || (index > 0 && values[index-1] >= value) {
			return false
		}
	}
	return true
}

type parsedHelperSemVer struct {
	major      *big.Int
	minor      *big.Int
	patch      *big.Int
	prerelease []string
}

func parseHelperSemVer(value string) (parsedHelperSemVer, bool) {
	if len(value) < 1 || len(value) > 64 {
		return parsedHelperSemVer{}, false
	}
	match := helperSemVerPattern.FindStringSubmatch(value)
	if match == nil {
		return parsedHelperSemVer{}, false
	}
	result := parsedHelperSemVer{major: new(big.Int), minor: new(big.Int), patch: new(big.Int)}
	result.major.SetString(match[1], 10)
	result.minor.SetString(match[2], 10)
	result.patch.SetString(match[3], 10)
	if match[4] != "" {
		result.prerelease = strings.Split(match[4], ".")
	}
	return result, true
}

func compareHelperPrerelease(left, right []string) int {
	if left == nil && right == nil {
		return 0
	}
	if left == nil {
		return 1
	}
	if right == nil {
		return -1
	}
	length := len(left)
	if len(right) > length {
		length = len(right)
	}
	for index := 0; index < length; index++ {
		if index >= len(left) {
			return -1
		}
		if index >= len(right) {
			return 1
		}
		if left[index] == right[index] {
			continue
		}
		leftNumber, leftOK := new(big.Int).SetString(left[index], 10)
		rightNumber, rightOK := new(big.Int).SetString(right[index], 10)
		if leftOK && rightOK {
			return leftNumber.Cmp(rightNumber)
		}
		if leftOK != rightOK {
			if leftOK {
				return -1
			}
			return 1
		}
		if left[index] < right[index] {
			return -1
		}
		return 1
	}
	return 0
}

func compareHelperSemVer(left, right string) (int, bool) {
	parsedLeft, ok := parseHelperSemVer(left)
	if !ok {
		return 0, false
	}
	parsedRight, ok := parseHelperSemVer(right)
	if !ok {
		return 0, false
	}
	for _, pair := range [][2]*big.Int{{parsedLeft.major, parsedRight.major}, {parsedLeft.minor, parsedRight.minor}, {parsedLeft.patch, parsedRight.patch}} {
		if compared := pair[0].Cmp(pair[1]); compared != 0 {
			return compared, true
		}
	}
	return compareHelperPrerelease(parsedLeft.prerelease, parsedRight.prerelease), true
}

func helperTargetEqual(left, right HelperTargetV1) bool {
	return reflect.DeepEqual(left, right)
}

func validateHelperManifestSchema(value HelperManifestV1) bool {
	if value.SchemaVersion != 1 {
		return false
	}
	if _, ok := parseHelperSemVer(value.HelperVersion); !ok {
		return false
	}
	if _, err := parseHelperUint64(value.ReleaseSequence, "release sequence", true); err != nil || !validHelperReleasedAt(value.ReleasedAt) {
		return false
	}
	packageTargets := map[string]HelperTargetV1{
		"@waifucave/ts-connect-darwin-arm64": {OS: "darwin", Arch: "arm64"},
		"@waifucave/ts-connect-win32-x64":    {OS: "win32", Arch: "x64"},
		"@waifucave/ts-connect-win32-arm64":  {OS: "win32", Arch: "arm64"},
		"@waifucave/ts-connect-linux-x64":    {OS: "linux", Arch: "x64"},
		"@waifucave/ts-connect-linux-arm64":  {OS: "linux", Arch: "arm64"},
	}
	goarm := uint8(7)
	packageTargets["@waifucave/ts-connect-linux-armv7"] = HelperTargetV1{OS: "linux", Arch: "arm", Goarm: &goarm}
	target, ok := packageTargets[value.PackageName]
	if !ok || !helperTargetEqual(value.Target, target) {
		return false
	}
	expectedBinaryPath := "bin/ts-connect"
	if value.Target.OS == "win32" {
		expectedBinaryPath = "bin/ts-connect.exe"
	}
	if value.Binary.RelativePath != expectedBinaryPath || !helperSHA256Pattern.MatchString(value.Binary.SHA256) {
		return false
	}
	if _, err := parseHelperUint64(value.Binary.ByteSize, "binary byte size", true); err != nil {
		return false
	}
	if value.Capabilities == nil || !validateHelperProtocols(value.Protocols) || !validateHelperCapabilities(value.Capabilities) {
		return false
	}
	_, minimumOK := parseHelperSemVer(value.MinimumDiscordWaifusVersion)
	_, maximumOK := parseHelperSemVer(value.MaximumDiscordWaifusVersionExclusive)
	if !minimumOK || !maximumOK {
		return false
	}
	compared, ok := compareHelperSemVer(value.MinimumDiscordWaifusVersion, value.MaximumDiscordWaifusVersionExclusive)
	if !ok || compared >= 0 {
		return false
	}
	if !helperGitSHA1Pattern.MatchString(value.SourceCommit) || !helperGitSHA1Pattern.MatchString(value.ContractCommit) || !helperGitSHA1Pattern.MatchString(value.ForkCommit) {
		return false
	}
	if !helperSHA256Pattern.MatchString(value.WorkerTrustRingSHA256) || !helperSHA256Pattern.MatchString(value.OSSNoticeSHA256) {
		return false
	}
	if value.Tailscale.Tag != "v1.102.2" || value.Tailscale.Commit != "eb67e5dcbe145d63e1128b9b4b630f8a82da101f" || value.GoVersion != "go1.26.5" || value.DirectOnlyBuildTag != "waifus_direct_only" {
		return false
	}
	if len(value.ReleaseKeyIDs) < 1 || len(value.ReleaseKeyIDs) > HelperReleaseTrustMaxKeys {
		return false
	}
	for index, keyID := range value.ReleaseKeyIDs {
		if !helperReleaseKeyIDPattern.MatchString(keyID) || (index > 0 && value.ReleaseKeyIDs[index-1] >= keyID) {
			return false
		}
	}
	return true
}

func canonicalHelperEqual(left, right any) bool {
	leftBytes, leftErr := CanonicalJSONV1(left)
	rightBytes, rightErr := CanonicalJSONV1(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftBytes, rightBytes)
}

func validateHelperExpected(manifest HelperManifestV1, expected HelperManifestExpectedV1) error {
	if manifest.PackageName != expected.PackageName {
		return helperManifestFailure("package_mismatch", "signed package name does not match")
	}
	if !helperTargetEqual(manifest.Target, expected.Target) {
		return helperManifestFailure("target_mismatch", "signed target does not match")
	}
	if manifest.HelperVersion != expected.PinnedHelperVersion {
		return helperManifestFailure("helper_version_mismatch", "helper version differs from the exact app pin")
	}
	minimum, err := parseHelperUint64(expected.MinimumReleaseSeq, "minimum release sequence", true)
	if err != nil {
		return helperManifestFailure("invalid_manifest", "minimum release sequence input is invalid")
	}
	release, _ := parseHelperUint64(manifest.ReleaseSequence, "release sequence", true)
	if release < minimum {
		return helperManifestFailure("release_sequence_rollback", "helper release sequence is below the app floor")
	}
	if !helperSHA256Pattern.MatchString(expected.WorkerTrustRingSHA256) || manifest.WorkerTrustRingSHA256 != expected.WorkerTrustRingSHA256 {
		return helperManifestFailure("worker_trust_ring_mismatch", "signed Worker trust-ring hash differs")
	}
	if !canonicalHelperEqual(manifest.Protocols, expected.Protocols) {
		return helperManifestFailure("protocol_mismatch", "helper protocol ranges differ")
	}
	if !reflect.DeepEqual(manifest.Capabilities, expected.Capabilities) {
		return helperManifestFailure("capability_mismatch", "helper capabilities differ")
	}
	belowMinimum, minimumOK := compareHelperSemVer(expected.AppVersion, manifest.MinimumDiscordWaifusVersion)
	atMaximum, maximumOK := compareHelperSemVer(expected.AppVersion, manifest.MaximumDiscordWaifusVersionExclusive)
	if !minimumOK || !maximumOK {
		return helperManifestFailure("invalid_manifest", "app compatibility version input is invalid")
	}
	if belowMinimum < 0 || atMaximum >= 0 {
		return helperManifestFailure("app_version_incompatible", "app version is outside the signed helper interval")
	}
	return nil
}

func helperExpectedBuildInfo(manifest HelperManifestV1) map[string]any {
	return map[string]any{
		"schemaVersion":         1,
		"helperVersion":         manifest.HelperVersion,
		"releaseSequence":       manifest.ReleaseSequence,
		"releasedAt":            manifest.ReleasedAt,
		"packageName":           manifest.PackageName,
		"target":                manifest.Target,
		"sourceCommit":          manifest.SourceCommit,
		"contractCommit":        manifest.ContractCommit,
		"forkCommit":            manifest.ForkCommit,
		"workerTrustRingSha256": manifest.WorkerTrustRingSHA256,
		"tailscale":             manifest.Tailscale,
		"goVersion":             manifest.GoVersion,
		"directOnlyBuildTag":    manifest.DirectOnlyBuildTag,
		"protocols":             manifest.Protocols,
		"capabilities":          manifest.Capabilities,
		"controlProfiles": []any{
			map[string]any{"controlProfile": 1, "name": "production", "httpsOrigin": "https://pair.waifucave.com", "webSocketOrigin": "wss://pair.waifucave.com", "workerCertificateKeyId": "waifucave-pair-certificate-2026-01"},
			map[string]any{"controlProfile": 2, "name": "staging", "httpsOrigin": "https://pair-staging.waifucave.com", "webSocketOrigin": "wss://pair-staging.waifucave.com", "workerCertificateKeyId": "waifucave-pair-staging-certificate-2026-01"},
		},
	}
}

func VerifyHelperManifestTrustV1(input HelperManifestTrustInputV1) (*VerifiedHelperManifestV1, error) {
	manifestBytes := append([]byte(nil), input.ManifestBytes...)
	if len(manifestBytes) < 1 || len(manifestBytes) > HelperManifestMaxBytes {
		return nil, helperManifestFailure("manifest_too_large", "helper manifest must contain 1-32,768 raw bytes")
	}
	trust, err := validateHelperTrustEntries(input.TrustEntries)
	if err != nil {
		return nil, err
	}
	selectors, err := parseHelperManifestSelectors(manifestBytes)
	if err != nil {
		return nil, err
	}
	verified, err := verifyHelperManifestSignatures(manifestBytes, selectors, input.Signatures, trust)
	if err != nil {
		return nil, err
	}
	var manifest HelperManifestV1
	if err := strictDecodeJSON(manifestBytes, &manifest); err != nil || !validateHelperManifestSchema(manifest) {
		return nil, helperManifestFailure("invalid_manifest", "signed helper manifest does not match the strict V1 schema")
	}
	canonical, err := CanonicalJSONV1(manifest)
	if err != nil || !bytes.Equal(canonical, manifestBytes) {
		return nil, helperManifestFailure("noncanonical_manifest", "signed manifest bytes are not canonical JSON")
	}
	if err := validateHelperExpected(manifest, input.Expected); err != nil {
		return nil, err
	}
	binarySize, _ := parseHelperUint64(manifest.Binary.ByteSize, "binary byte size", true)
	if uint64(len(input.BinaryBytes)) != binarySize {
		return nil, helperManifestFailure("binary_size_mismatch", "helper binary byte size differs")
	}
	binaryHash := sha256.Sum256(input.BinaryBytes)
	if hex.EncodeToString(binaryHash[:]) != manifest.Binary.SHA256 {
		return nil, helperManifestFailure("binary_hash_mismatch", "helper binary hash differs")
	}
	noticeHash := sha256.Sum256(input.NoticesBytes)
	if hex.EncodeToString(noticeHash[:]) != manifest.OSSNoticeSHA256 {
		return nil, helperManifestFailure("notices_hash_mismatch", "notice inventory hash differs")
	}
	if !canonicalHelperEqual(input.EmbeddedBuildInfo, helperExpectedBuildInfo(manifest)) {
		return nil, helperManifestFailure("embedded_build_info_mismatch", "helper version metadata differs from the signed manifest")
	}
	return &VerifiedHelperManifestV1{
		Manifest: manifest, ManifestBytes: manifestBytes,
		VerifiedReleaseKeyIDs: append([]string(nil), verified...),
	}, nil
}
