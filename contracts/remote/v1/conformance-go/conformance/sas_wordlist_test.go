package conformance_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/pairing"
)

const sasWordlistV1SHA256 = "75282c58b95c5c9b54f8b570a74bf85e1ffd78bd7d44973a82c7aebadb813874"

func TestSASWordlistV1ArtifactAndMapping(t *testing.T) {
	wordlistPath := filepath.Join("..", "..", "..", "..", "wordlists", "sas-v1.txt")
	contents, err := os.ReadFile(wordlistPath)
	if err != nil {
		t.Fatalf("read SAS V1 wordlist: %v", err)
	}
	digest := sha256.Sum256(contents)
	if actual := hex.EncodeToString(digest[:]); actual != sasWordlistV1SHA256 {
		t.Fatalf("SAS V1 wordlist SHA-256 = %s, want %s", actual, sasWordlistV1SHA256)
	}
	if !bytes.HasSuffix(contents, []byte("\n")) || bytes.Contains(contents, []byte("\r")) {
		t.Fatalf("SAS V1 wordlist must be LF-terminated without CR bytes")
	}
	words := strings.Split(strings.TrimSuffix(string(contents), "\n"), "\n")
	if len(words) != len(pairing.SASWordsV1) {
		t.Fatalf("SAS V1 wordlist contains %d words, want %d", len(words), len(pairing.SASWordsV1))
	}
	for index, word := range words {
		if pairing.SASWordsV1[index] != word {
			t.Fatalf("SAS V1 word %d = %q, generated mapping has %q", index, word, pairing.SASWordsV1[index])
		}
	}

	assertSASMapping(t, [5]uint16{369, 665, 342, 722, 849}, [5]string{
		"froth", "rally", "flap", "scan", "storm",
	})
	assertSASMapping(t, [5]uint16{562, 601, 910, 396, 172}, [5]string{
		"next", "petty", "trade", "gown", "clump",
	})
	if _, err := pairing.MapSASIndicesToWordsV1([5]uint16{0, 1, 2, 3, 1024}); err == nil {
		t.Fatalf("out-of-range SAS V1 index was accepted")
	}
}

func assertSASMapping(t *testing.T, indices [5]uint16, expected [5]string) {
	t.Helper()
	actual, err := pairing.MapSASIndicesToWordsV1(indices)
	if err != nil {
		t.Fatalf("map SAS V1 indices: %v", err)
	}
	if actual != expected {
		t.Fatalf("SAS V1 words = %v, want %v", actual, expected)
	}
}
