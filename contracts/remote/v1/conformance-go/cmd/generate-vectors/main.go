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
	check := flag.Bool("check", false, "verify that the committed WIPC fixture matches the independent Go generator")
	flag.Parse()
	if !*check || flag.NArg() != 0 {
		return fmt.Errorf("usage: generate-vectors --check")
	}
	expected, err := vectors.BuildWIPCV1JSON()
	if err != nil {
		return fmt.Errorf("build WIPC fixture: %w", err)
	}
	fixturePath := filepath.Join("..", "fixtures", "crypto", "wipc-v1.json")
	actual, err := os.ReadFile(fixturePath)
	if err != nil {
		return fmt.Errorf("read %s: %w", fixturePath, err)
	}
	if !bytes.Equal(actual, expected) {
		return fmt.Errorf("%s differs from the independent Go generator", fixturePath)
	}
	fmt.Printf("verified %s\n", fixturePath)
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
