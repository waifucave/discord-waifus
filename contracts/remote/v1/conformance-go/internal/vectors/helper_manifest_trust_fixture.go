package vectors

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
)

const (
	helperManifestNewKeyID = "waifucave-ts-connect-release-test-new"
	helperManifestOldKeyID = "waifucave-ts-connect-release-test-old"
)

var (
	helperManifestNewKeySeed = pairing.Sequence(0x20, 32)
	helperManifestOldKeySeed = pairing.Sequence(0x60, 32)
)

func helperManifestHashHex(value []byte) string {
	hash := sha256.Sum256(value)
	return hex.EncodeToString(hash[:])
}

func helperManifestCloneMap(value map[string]any) map[string]any {
	return controlClone(value).(map[string]any)
}

func helperManifestObject(value any) map[string]any {
	return value.(map[string]any)
}

func helperManifestArray(value any) []any {
	return value.([]any)
}

func helperManifestSignatures(manifestBytes []byte, releaseKeyIDs []any) map[string]any {
	result := make(map[string]any, len(releaseKeyIDs))
	for _, raw := range releaseKeyIDs {
		keyID := raw.(string)
		var signature []byte
		switch keyID {
		case helperManifestNewKeyID:
			signature = ed25519.Sign(ed25519.NewKeyFromSeed(helperManifestNewKeySeed), manifestBytes)
		case helperManifestOldKeyID:
			signature = ed25519.Sign(ed25519.NewKeyFromSeed(helperManifestOldKeySeed), manifestBytes)
		default:
			signature = bytes.Repeat([]byte{0xaa}, ed25519.SignatureSize)
		}
		result[keyID] = pairing.B64(signature)
	}
	return result
}

func helperManifestBase(binary, notices, workerTrustRing []byte) map[string]any {
	return map[string]any{
		"schemaVersion":   1,
		"helperVersion":   "0.1.0",
		"releaseSequence": "42",
		"releasedAt":      "2026-08-09T10:20:30Z",
		"packageName":     "@waifucave/ts-connect-linux-x64",
		"target":          map[string]any{"os": "linux", "arch": "x64"},
		"binary": map[string]any{
			"relativePath": "bin/ts-connect",
			"byteSize":     fmt.Sprintf("%d", len(binary)),
			"sha256":       helperManifestHashHex(binary),
		},
		"protocols": map[string]any{
			"ipc":            map[string]any{"major": 1, "minimumMinor": 0, "maximumMinor": 0},
			"coordination":   map[string]any{"major": 1, "minimumMinor": 0, "maximumMinor": 0},
			"directService":  map[string]any{"major": 1, "minimumMinor": 0, "maximumMinor": 0},
			"helperManifest": map[string]any{"major": 1, "minimumMinor": 0, "maximumMinor": 0},
		},
		"capabilities": []any{
			"waifus.browser-context.v1",
			"waifus.dashboard.manifest.v1",
			"waifus.http.v1",
			"waifus.principal.v1",
			"waifus.sse.cursor.v1",
			"waifus.stream.cancel.v1",
		},
		"minimumDiscordWaifusVersion":          "1.5.200",
		"maximumDiscordWaifusVersionExclusive": "1.6.0",
		"sourceCommit":                         strings.Repeat("2", 40),
		"contractCommit":                       strings.Repeat("3", 40),
		"forkCommit":                           strings.Repeat("4", 40),
		"workerTrustRingSha256":                helperManifestHashHex(workerTrustRing),
		"tailscale": map[string]any{
			"tag": "v1.102.2", "commit": "eb67e5dcbe145d63e1128b9b4b630f8a82da101f",
		},
		"goVersion":          "go1.26.5",
		"directOnlyBuildTag": "waifus_direct_only",
		"ossNoticeSha256":    helperManifestHashHex(notices),
		"releaseKeyIds":      []any{helperManifestNewKeyID, helperManifestOldKeyID},
	}
}

func helperManifestBuildInfo(manifest map[string]any) map[string]any {
	return map[string]any{
		"schemaVersion":         manifest["schemaVersion"],
		"helperVersion":         manifest["helperVersion"],
		"releaseSequence":       manifest["releaseSequence"],
		"releasedAt":            manifest["releasedAt"],
		"packageName":           manifest["packageName"],
		"target":                controlClone(manifest["target"]),
		"sourceCommit":          manifest["sourceCommit"],
		"contractCommit":        manifest["contractCommit"],
		"forkCommit":            manifest["forkCommit"],
		"workerTrustRingSha256": manifest["workerTrustRingSha256"],
		"tailscale":             controlClone(manifest["tailscale"]),
		"goVersion":             manifest["goVersion"],
		"directOnlyBuildTag":    manifest["directOnlyBuildTag"],
		"protocols":             controlClone(manifest["protocols"]),
		"capabilities":          controlClone(manifest["capabilities"]),
		"controlProfiles": []any{
			map[string]any{
				"controlProfile": 1, "name": "production",
				"httpsOrigin": "https://pair.waifucave.com", "webSocketOrigin": "wss://pair.waifucave.com",
				"workerCertificateKeyId": "waifucave-pair-certificate-2026-01",
			},
			map[string]any{
				"controlProfile": 2, "name": "staging",
				"httpsOrigin": "https://pair-staging.waifucave.com", "webSocketOrigin": "wss://pair-staging.waifucave.com",
				"workerCertificateKeyId": "waifucave-pair-staging-certificate-2026-01",
			},
		},
	}
}

func helperManifestInput(manifestBytes []byte, signatures map[string]any, trustEntries []any, binary, notices []byte, expected, embeddedBuildInfo map[string]any) map[string]any {
	return map[string]any{
		"manifestBytesB64":  pairing.B64(manifestBytes),
		"signatures":        controlClone(signatures),
		"trustEntries":      controlClone(trustEntries),
		"binaryB64":         pairing.B64(binary),
		"noticesB64":        pairing.B64(notices),
		"expected":          controlClone(expected),
		"embeddedBuildInfo": controlClone(embeddedBuildInfo),
	}
}

func helperManifestRejection(name, code string, input map[string]any) map[string]any {
	return map[string]any{"name": name, "errorCode": code, "input": input}
}

func helperManifestSignedInput(base map[string]any, mutate func(map[string]any), trustEntries []any, binary, notices []byte, expected, embeddedBuildInfo map[string]any) (map[string]any, error) {
	manifest := helperManifestCloneMap(base)
	mutate(manifest)
	manifestBytes, err := pairing.CanonicalJSONV1(manifest)
	if err != nil {
		return nil, err
	}
	ids := helperManifestArray(manifest["releaseKeyIds"])
	return helperManifestInput(
		manifestBytes,
		helperManifestSignatures(manifestBytes, ids),
		trustEntries,
		binary,
		notices,
		expected,
		embeddedBuildInfo,
	), nil
}

func BuildHelperManifestTrustV1() (map[string]any, error) {
	binary := []byte("ts-connect deterministic test binary v1\n")
	notices := []byte("deterministic test notices v1\n")
	workerTrustRing := []byte("deterministic WORKER_KEYS.lock test bytes v1\n")
	manifest := helperManifestBase(binary, notices, workerTrustRing)
	manifestBytes, err := pairing.CanonicalJSONV1(manifest)
	if err != nil {
		return nil, err
	}

	newPublic := ed25519.NewKeyFromSeed(helperManifestNewKeySeed).Public().(ed25519.PublicKey)
	oldPublic := ed25519.NewKeyFromSeed(helperManifestOldKeySeed).Public().(ed25519.PublicKey)
	newFingerprint, err := pairing.DeriveHelperReleaseKeyFingerprintV1(helperManifestNewKeyID, newPublic)
	if err != nil {
		return nil, err
	}
	oldFingerprint, err := pairing.DeriveHelperReleaseKeyFingerprintV1(helperManifestOldKeyID, oldPublic)
	if err != nil {
		return nil, err
	}
	releaseKeys := []any{
		map[string]any{
			"keyId": helperManifestNewKeyID, "privateSeedB64": pairing.B64(helperManifestNewKeySeed),
			"publicKeyB64": pairing.B64(newPublic), "fingerprint": newFingerprint,
		},
		map[string]any{
			"keyId": helperManifestOldKeyID, "privateSeedB64": pairing.B64(helperManifestOldKeySeed),
			"publicKeyB64": pairing.B64(oldPublic), "fingerprint": oldFingerprint,
		},
	}
	trustEntries := []any{
		map[string]any{
			"keyId": helperManifestNewKeyID, "publicKeyB64": pairing.B64(newPublic), "fingerprint": newFingerprint,
			"sequenceFrom": "42", "sequenceThrough": "100",
			"releasedAtFrom": "2026-08-09T10:20:30Z", "releasedAtThrough": "2027-12-31T23:59:59Z",
		},
		map[string]any{
			"keyId": helperManifestOldKeyID, "publicKeyB64": pairing.B64(oldPublic), "fingerprint": oldFingerprint,
			"sequenceFrom": "1", "sequenceThrough": "42",
			"releasedAtFrom": "2026-01-01T00:00:00Z", "releasedAtThrough": "2026-08-09T10:20:30Z",
		},
	}
	expected := map[string]any{
		"packageName": manifest["packageName"], "target": controlClone(manifest["target"]),
		"appVersion": "1.5.203", "pinnedHelperVersion": "0.1.0", "minimumReleaseSequence": "42",
		"workerTrustRingSha256": manifest["workerTrustRingSha256"],
		"protocols":             controlClone(manifest["protocols"]), "capabilities": controlClone(manifest["capabilities"]),
	}
	embeddedBuildInfo := helperManifestBuildInfo(manifest)
	valid := helperManifestInput(
		manifestBytes,
		helperManifestSignatures(manifestBytes, helperManifestArray(manifest["releaseKeyIds"])),
		trustEntries,
		binary,
		notices,
		expected,
		embeddedBuildInfo,
	)

	rejections := make([]any, 0, 41)
	addInput := func(name, code string, mutate func(map[string]any)) {
		input := helperManifestCloneMap(valid)
		mutate(input)
		rejections = append(rejections, helperManifestRejection(name, code, input))
	}
	addManifest := func(name, code string, mutate func(map[string]any)) error {
		input, err := helperManifestSignedInput(manifest, mutate, trustEntries, binary, notices, expected, embeddedBuildInfo)
		if err != nil {
			return err
		}
		rejections = append(rejections, helperManifestRejection(name, code, input))
		return nil
	}

	addInput("manifest-over-limit", "manifest_too_large", func(input map[string]any) {
		input["manifestBytesB64"] = pairing.B64(bytes.Repeat([]byte{'a'}, pairing.HelperManifestMaxBytes+1))
	})
	noncanonicalBytes := append([]byte{' '}, manifestBytes...)
	noncanonical := helperManifestInput(
		noncanonicalBytes,
		helperManifestSignatures(noncanonicalBytes, helperManifestArray(manifest["releaseKeyIds"])),
		trustEntries,
		binary,
		notices,
		expected,
		embeddedBuildInfo,
	)
	rejections = append(rejections, helperManifestRejection("signed-noncanonical-json", "noncanonical_manifest", noncanonical))
	if err := addManifest("signed-unknown-manifest-field", "invalid_manifest", func(value map[string]any) {
		value["controlUrl"] = "https://example.invalid"
	}); err != nil {
		return nil, err
	}
	addInput("invalid-new-key-signature", "invalid_signature", func(input map[string]any) {
		signatures := helperManifestObject(input["signatures"])
		decoded, _ := base64.RawURLEncoding.DecodeString(signatures[helperManifestNewKeyID].(string))
		decoded[0] ^= 1
		signatures[helperManifestNewKeyID] = pairing.B64(decoded)
	})
	addInput("missing-overlap-signature", "missing_signature", func(input map[string]any) {
		delete(helperManifestObject(input["signatures"]), helperManifestOldKeyID)
	})
	addInput("undeclared-extra-signature", "unknown_signature", func(input map[string]any) {
		helperManifestObject(input["signatures"])["waifucave-ts-connect-release-test-extra"] = pairing.B64(bytes.Repeat([]byte{1}, 64))
	})
	if err := addManifest("unknown-declared-release-key", "unknown_release_key", func(value map[string]any) {
		value["releaseKeyIds"] = []any{helperManifestNewKeyID, helperManifestOldKeyID, "waifucave-ts-connect-release-test-unknown"}
	}); err != nil {
		return nil, err
	}
	addInput("new-key-sequence-window", "key_sequence_out_of_window", func(input map[string]any) {
		helperManifestObject(helperManifestArray(input["trustEntries"])[0])["sequenceFrom"] = "43"
	})
	addInput("new-key-time-window", "key_time_out_of_window", func(input map[string]any) {
		helperManifestObject(helperManifestArray(input["trustEntries"])[0])["releasedAtFrom"] = "2026-08-09T10:20:31Z"
	})
	addInput("compromise-window-narrowing", "key_sequence_out_of_window", func(input map[string]any) {
		helperManifestObject(helperManifestArray(input["trustEntries"])[1])["sequenceThrough"] = "41"
	})
	addInput("release-key-fingerprint", "invalid_release_key_fingerprint", func(input map[string]any) {
		helperManifestObject(helperManifestArray(input["trustEntries"])[0])["fingerprint"] = strings.Repeat("0", 64)
	})
	addInput("reversed-key-sequence-window", "invalid_trust_ring", func(input map[string]any) {
		helperManifestObject(helperManifestArray(input["trustEntries"])[0])["sequenceFrom"] = "101"
	})
	addInput("reversed-key-time-window", "invalid_trust_ring", func(input map[string]any) {
		helperManifestObject(helperManifestArray(input["trustEntries"])[0])["releasedAtFrom"] = "2028-01-01T00:00:00Z"
	})
	addInput("duplicate-release-public-key", "invalid_trust_ring", func(input map[string]any) {
		entries := helperManifestArray(input["trustEntries"])
		helperManifestObject(entries[1])["publicKeyB64"] = helperManifestObject(entries[0])["publicKeyB64"]
	})
	addInput("wrong-signature-width", "invalid_signature", func(input map[string]any) {
		helperManifestObject(input["signatures"])[helperManifestNewKeyID] = pairing.B64(bytes.Repeat([]byte{1}, 63))
	})
	addInput("release-sequence-downgrade", "release_sequence_rollback", func(input map[string]any) {
		helperManifestObject(input["expected"])["minimumReleaseSequence"] = "43"
	})
	addInput("Worker-trust-ring-mismatch", "worker_trust_ring_mismatch", func(input map[string]any) {
		helperManifestObject(input["expected"])["workerTrustRingSha256"] = strings.Repeat("0", 64)
	})
	addInput("package-mismatch", "package_mismatch", func(input map[string]any) {
		helperManifestObject(input["expected"])["packageName"] = "@waifucave/ts-connect-linux-arm64"
	})
	addInput("target-mismatch", "target_mismatch", func(input map[string]any) {
		helperManifestObject(input["expected"])["target"] = map[string]any{"os": "darwin", "arch": "arm64"}
	})
	addInput("helper-version-mismatch", "helper_version_mismatch", func(input map[string]any) {
		helperManifestObject(input["expected"])["pinnedHelperVersion"] = "0.1.1"
	})
	addInput("protocol-range-mismatch", "protocol_mismatch", func(input map[string]any) {
		protocols := helperManifestObject(helperManifestObject(input["expected"])["protocols"])
		helperManifestObject(protocols["ipc"])["maximumMinor"] = 1
	})
	addInput("capability-mismatch", "capability_mismatch", func(input map[string]any) {
		helperManifestObject(input["expected"])["capabilities"] = []any{"waifus.http.v1"}
	})
	addInput("app-version-below-minimum", "app_version_incompatible", func(input map[string]any) {
		helperManifestObject(input["expected"])["appVersion"] = "1.5.199"
	})
	addInput("app-version-at-exclusive-maximum", "app_version_incompatible", func(input map[string]any) {
		helperManifestObject(input["expected"])["appVersion"] = "1.6.0"
	})
	addInput("binary-size-mismatch", "binary_size_mismatch", func(input map[string]any) {
		input["binaryB64"] = pairing.B64(append(append([]byte(nil), binary...), 0))
	})
	addInput("binary-hash-mismatch", "binary_hash_mismatch", func(input map[string]any) {
		changed := append([]byte(nil), binary...)
		changed[0] ^= 1
		input["binaryB64"] = pairing.B64(changed)
	})
	addInput("notices-hash-mismatch", "notices_hash_mismatch", func(input map[string]any) {
		input["noticesB64"] = pairing.B64([]byte("changed notices\n"))
	})
	addInput("embedded-helper-version", "embedded_build_info_mismatch", func(input map[string]any) {
		helperManifestObject(input["embeddedBuildInfo"])["helperVersion"] = "0.1.1"
	})
	addInput("embedded-Worker-trust-ring", "embedded_build_info_mismatch", func(input map[string]any) {
		helperManifestObject(input["embeddedBuildInfo"])["workerTrustRingSha256"] = strings.Repeat("0", 64)
	})

	manifestRejections := []struct {
		name string
		code string
		edit func(map[string]any)
	}{
		{"signed-release-time-before-window", "key_time_out_of_window", func(value map[string]any) { value["releasedAt"] = "2025-12-31T23:59:59Z" }},
		{"signed-release-time-after-window", "key_time_out_of_window", func(value map[string]any) { value["releasedAt"] = "2028-01-01T00:00:00Z" }},
		{"signed-release-sequence-before-overlap", "key_sequence_out_of_window", func(value map[string]any) { value["releaseSequence"] = "41" }},
		{"malformed-signed-release-time", "invalid_manifest", func(value map[string]any) { value["releasedAt"] = "2026-08-09T10:20:30.000Z" }},
		{"unsorted-release-key-ids", "invalid_manifest", func(value map[string]any) {
			value["releaseKeyIds"] = []any{helperManifestOldKeyID, helperManifestNewKeyID}
		}},
		{"wrong-Worker-trust-ring-in-manifest", "worker_trust_ring_mismatch", func(value map[string]any) { value["workerTrustRingSha256"] = strings.Repeat("0", 64) }},
		{"wrong-fork-commit-in-build-info", "embedded_build_info_mismatch", func(value map[string]any) { value["forkCommit"] = strings.Repeat("7", 40) }},
		{"wrong-Tailscale-tag", "invalid_manifest", func(value map[string]any) { helperManifestObject(value["tailscale"])["tag"] = "v1.102.1" }},
		{"wrong-Go-version", "invalid_manifest", func(value map[string]any) { value["goVersion"] = "go1.26.4" }},
		{"missing-direct-only-tag", "invalid_manifest", func(value map[string]any) { value["directOnlyBuildTag"] = "default" }},
		{"unsorted-manifest-capabilities", "invalid_manifest", func(value map[string]any) { value["capabilities"] = []any{"waifus.stream.cancel.v1", "waifus.http.v1"} }},
		{"unsafe-binary-path", "invalid_manifest", func(value map[string]any) { helperManifestObject(value["binary"])["relativePath"] = "../../ts-connect" }},
	}
	for _, vector := range manifestRejections {
		if err := addManifest(vector.name, vector.code, vector.edit); err != nil {
			return nil, err
		}
	}

	return map[string]any{
		"version":      1,
		"testOnlyKeys": true,
		"releaseKeys":  releaseKeys,
		"payloads": map[string]any{
			"binaryB64": pairing.B64(binary), "noticesB64": pairing.B64(notices),
			"workerTrustRingB64": pairing.B64(workerTrustRing),
		},
		"valid":      valid,
		"rejections": rejections,
	}, nil
}

func BuildHelperManifestTrustV1JSON() ([]byte, error) {
	value, err := BuildHelperManifestTrustV1()
	if err != nil {
		return nil, err
	}
	return pairing.CanonicalJSONV1(value)
}

func DecodeHelperManifestTrustV1Fixture(encoded []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}
