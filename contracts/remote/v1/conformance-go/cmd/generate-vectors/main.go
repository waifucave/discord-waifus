package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/waifucave/discord-waifus/contracts/remote/v1/conformance-go/internal/vectors"
)

func run() error {
	check := flag.Bool("check", false, "verify that committed fixtures match the independent Go generator")
	flag.Parse()
	if !*check || flag.NArg() != 0 {
		return fmt.Errorf("usage: generate-vectors --check")
	}
	checks := []struct {
		name  string
		build func() ([]byte, error)
	}{
		{name: "wipc-v1.json", build: vectors.BuildWIPCV1JSON},
		{name: "wipc-state-v1.json", build: vectors.BuildWIPCStateV1JSON},
		{name: "wipc-auth-session-v1.json", build: vectors.BuildWIPCAuthSessionV1JSON},
		{name: "pairing-v1.json", build: vectors.BuildPairingV1JSON},
		{name: "pair-confirmation-v1.json", build: vectors.BuildPairConfirmationV1JSON},
		{name: "pair-control-record-v1.json", build: vectors.BuildPairControlV1JSON},
		{name: "service-session-v1.json", build: vectors.BuildServiceSessionV1JSON},
		{name: "endpoint-envelope-v1.json", build: vectors.BuildEndpointEnvelopeV1JSON},
	}
	for _, fixture := range checks {
		expected, err := fixture.build()
		if err != nil {
			return fmt.Errorf("build %s: %w", fixture.name, err)
		}
		fixturePath := filepath.Join("..", "fixtures", "crypto", fixture.name)
		actual, err := os.ReadFile(fixturePath)
		if err != nil {
			return fmt.Errorf("read %s: %w", fixturePath, err)
		}
		if !bytes.Equal(actual, expected) {
			return fmt.Errorf("%s differs from the independent Go generator", fixturePath)
		}
		fmt.Printf("verified %s\n", fixturePath)
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
