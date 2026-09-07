// Command gencert writes a self-signed TLS key pair for local development and
// for the end-to-end suites that need the relay listening on HTTPS.
//
// It exists so a test can produce a certificate without depending on an
// `openssl` binary being present or on a particular OpenSSL/LibreSSL dialect.
// It is not the production path: on the tailnet, `tailscale cert` issues and
// renews the real certificate and the relay only reads the files.
//
//	go -C apps/relay run ./internal/devcert/gencert --out /tmp/tls --hosts localhost,127.0.0.1
//
// It prints the two paths it wrote and nothing else. Key material is never
// printed.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"echolet/apps/relay/internal/devcert"
)

func main() {
	out := flag.String("out", ".", "directory to write cert.pem and key.pem into")
	hosts := flag.String("hosts", "localhost,127.0.0.1", "comma-separated DNS names and IP addresses for the certificate SAN")
	days := flag.Int("days", 30, "certificate lifetime in days")
	certName := flag.String("cert-name", "cert.pem", "certificate file name")
	keyName := flag.String("key-name", "key.pem", "private key file name")
	flag.Parse()

	names := make([]string, 0, 4)
	for _, host := range strings.Split(*hosts, ",") {
		if trimmed := strings.TrimSpace(host); trimmed != "" {
			names = append(names, trimmed)
		}
	}

	pair, err := devcert.Generate(names, time.Duration(*days)*24*time.Hour)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}

	if err := os.MkdirAll(*out, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "gencert: create output directory:", err.Error())
		os.Exit(1)
	}
	certPath, keyPath := filepath.Join(*out, *certName), filepath.Join(*out, *keyName)
	if err := os.WriteFile(certPath, pair.CertPEM, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "gencert: write certificate:", err.Error())
		os.Exit(1)
	}
	if err := os.WriteFile(keyPath, pair.KeyPEM, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "gencert: write key:", err.Error())
		os.Exit(1)
	}
	fmt.Println(certPath)
	fmt.Println(keyPath)
}
