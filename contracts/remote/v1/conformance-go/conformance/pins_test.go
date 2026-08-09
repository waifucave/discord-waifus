package conformance_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/flynn/noise"
)

func TestPinnedToolchainAndNoiseModule(t *testing.T) {
	if got := runtime.Version(); got != "go1.26.5" {
		t.Fatalf("Go toolchain = %q, want go1.26.5", got)
	}
	if noise.HandshakeXX.Name != "XX" {
		t.Fatalf("pinned Noise package does not expose the XX pattern")
	}
	moduleFile, err := os.ReadFile(filepath.Join("..", "go.mod"))
	if err != nil {
		t.Fatalf("read go.mod: %v", err)
	}
	if !strings.Contains(string(moduleFile), "github.com/flynn/noise v1.1.0") {
		t.Fatalf("go.mod does not pin github.com/flynn/noise v1.1.0")
	}
	sumFile, err := os.ReadFile(filepath.Join("..", "go.sum"))
	if err != nil {
		t.Fatalf("read go.sum: %v", err)
	}
	if !strings.Contains(
		string(sumFile),
		"github.com/flynn/noise v1.1.0 h1:KjPQoQCEFdZDiP03phOvGi11+SVVhBG2wOWAorLsstg=",
	) {
		t.Fatalf("go.sum does not contain the pinned Noise module checksum")
	}
}
