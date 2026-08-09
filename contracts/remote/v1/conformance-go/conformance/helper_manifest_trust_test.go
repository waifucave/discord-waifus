package conformance_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/vectors"
)

func helperManifestTrustFixtureBytes(t *testing.T) []byte {
	t.Helper()
	value, err := os.ReadFile(filepath.Join("..", "..", "fixtures", "crypto", "helper-manifest-trust-v1.json"))
	if err != nil {
		t.Fatalf("read helper-manifest trust fixture: %v", err)
	}
	return value
}

func helperManifestTrustFixture(t *testing.T) map[string]any {
	t.Helper()
	value, err := vectors.DecodeHelperManifestTrustV1Fixture(helperManifestTrustFixtureBytes(t))
	if err != nil {
		t.Fatalf("decode helper-manifest trust fixture: %v", err)
	}
	return value
}

func helperManifestObject(t *testing.T, value any, name string) map[string]any {
	t.Helper()
	result, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s must be an object, got %T", name, value)
	}
	return result
}

func helperManifestArray(t *testing.T, value any, name string) []any {
	t.Helper()
	result, ok := value.([]any)
	if !ok {
		t.Fatalf("%s must be an array, got %T", name, value)
	}
	return result
}

func helperManifestString(t *testing.T, value any, name string) string {
	t.Helper()
	result, ok := value.(string)
	if !ok {
		t.Fatalf("%s must be a string, got %T", name, value)
	}
	return result
}

func helperManifestRemarshal(t *testing.T, value any, output any, name string) {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal %s: %v", name, err)
	}
	if err := json.Unmarshal(encoded, output); err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
}

func helperManifestTrustInput(t *testing.T, value map[string]any) pairing.HelperManifestTrustInputV1 {
	t.Helper()
	signatures := map[string][]byte{}
	for keyID, raw := range helperManifestObject(t, value["signatures"], "signatures") {
		signatures[keyID] = decodeBase64URL(t, helperManifestString(t, raw, "signature"))
	}
	var trustEntries []pairing.HelperReleaseTrustEntryV1
	helperManifestRemarshal(t, value["trustEntries"], &trustEntries, "trust entries")
	var expected pairing.HelperManifestExpectedV1
	helperManifestRemarshal(t, value["expected"], &expected, "expected compatibility")
	return pairing.HelperManifestTrustInputV1{
		ManifestBytes:     decodeBase64URL(t, helperManifestString(t, value["manifestBytesB64"], "manifest bytes")),
		Signatures:        signatures,
		TrustEntries:      trustEntries,
		BinaryBytes:       decodeBase64URL(t, helperManifestString(t, value["binaryB64"], "binary bytes")),
		NoticesBytes:      decodeBase64URL(t, helperManifestString(t, value["noticesB64"], "notice bytes")),
		Expected:          expected,
		EmbeddedBuildInfo: helperManifestObject(t, value["embeddedBuildInfo"], "embedded build info"),
	}
}

func requireHelperManifestTrustCode(t *testing.T, err error, expected, name string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s unexpectedly succeeded", name)
	}
	if actual := pairing.HelperManifestTrustErrorCode(err); actual != expected {
		t.Fatalf("%s returned %q instead of %q: %v", name, actual, expected, err)
	}
}

func helperManifestStringsEqual(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func TestHelperManifestTrustFixtureExactBytes(t *testing.T) {
	expected, err := vectors.BuildHelperManifestTrustV1JSON()
	if err != nil {
		t.Fatalf("build helper-manifest trust fixture: %v", err)
	}
	if actual := helperManifestTrustFixtureBytes(t); !bytes.Equal(actual, expected) {
		t.Fatalf("helper-manifest trust fixture differs (actual=%d expected=%d)", len(actual), len(expected))
	}
}

func TestHelperManifestTrustValidOverlapAndFingerprints(t *testing.T) {
	fixture := helperManifestTrustFixture(t)
	valid := helperManifestObject(t, fixture["valid"], "valid trust input")
	verified, err := pairing.VerifyHelperManifestTrustV1(helperManifestTrustInput(t, valid))
	if err != nil {
		t.Fatalf("verify valid helper manifest: %v", err)
	}
	if verified.Manifest.ReleaseSequence != "42" {
		t.Fatalf("release sequence = %q, want 42", verified.Manifest.ReleaseSequence)
	}
	wantKeyIDs := []string{
		"waifucave-ts-connect-release-test-new",
		"waifucave-ts-connect-release-test-old",
	}
	if !helperManifestStringsEqual(verified.VerifiedReleaseKeyIDs, wantKeyIDs) {
		t.Fatalf("verified release keys = %v, want %v", verified.VerifiedReleaseKeyIDs, wantKeyIDs)
	}
	if !bytes.Equal(verified.ManifestBytes, decodeBase64URL(t, helperManifestString(t, valid["manifestBytesB64"], "manifest bytes"))) {
		t.Fatal("verified manifest bytes differ from the exact signed input")
	}
	for _, raw := range helperManifestArray(t, fixture["releaseKeys"], "release keys") {
		key := helperManifestObject(t, raw, "release key")
		fingerprint, err := pairing.DeriveHelperReleaseKeyFingerprintV1(
			helperManifestString(t, key["keyId"], "release key ID"),
			decodeBase64URL(t, helperManifestString(t, key["publicKeyB64"], "release public key")),
		)
		if err != nil {
			t.Fatalf("derive release-key fingerprint: %v", err)
		}
		if expected := helperManifestString(t, key["fingerprint"], "release-key fingerprint"); fingerprint != expected {
			t.Fatalf("release-key fingerprint = %q, want %q", fingerprint, expected)
		}
	}
}

func TestHelperManifestTrustRejections(t *testing.T) {
	fixture := helperManifestTrustFixture(t)
	for _, raw := range helperManifestArray(t, fixture["rejections"], "trust rejections") {
		vector := helperManifestObject(t, raw, "trust rejection")
		name := helperManifestString(t, vector["name"], "trust rejection name")
		_, err := pairing.VerifyHelperManifestTrustV1(helperManifestTrustInput(
			t,
			helperManifestObject(t, vector["input"], "trust rejection input"),
		))
		requireHelperManifestTrustCode(
			t,
			err,
			helperManifestString(t, vector["errorCode"], "trust rejection code"),
			name,
		)
	}
}
