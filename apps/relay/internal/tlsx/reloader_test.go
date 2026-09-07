package tlsx

import (
	"crypto/tls"
	"crypto/x509"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"echolet/apps/relay/internal/devcert"
)

func writePair(t *testing.T, dir string) (certPath, keyPath string) {
	t.Helper()
	pair, err := devcert.Generate([]string{"localhost", "127.0.0.1"}, time.Hour)
	if err != nil {
		t.Fatalf("devcert.Generate: %v", err)
	}
	certPath, keyPath = filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certPath, pair.CertPEM, 0o644); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	if err := os.WriteFile(keyPath, pair.KeyPEM, 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	return certPath, keyPath
}

func serial(t *testing.T, certificate *tls.Certificate) string {
	t.Helper()
	if certificate == nil || len(certificate.Certificate) == 0 {
		t.Fatal("reloader returned a certificate with no chain")
	}
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		t.Fatalf("parse leaf: %v", err)
	}
	return leaf.SerialNumber.String()
}

func TestNewCertificateReloaderRefusesAMissingCertificate(t *testing.T) {
	dir := t.TempDir()
	_, keyPath := writePair(t, dir)

	_, err := NewCertificateReloader(filepath.Join(dir, "absent.pem"), keyPath, 0)
	if err == nil {
		t.Fatal("NewCertificateReloader returned nil for a missing certificate file, want a refusal")
	}
	if !strings.Contains(err.Error(), "absent.pem") {
		t.Fatalf("error %q does not name the offending path", err.Error())
	}
}

func TestNewCertificateReloaderRefusesAMismatchedPair(t *testing.T) {
	dirA, dirB := t.TempDir(), t.TempDir()
	certPath, _ := writePair(t, dirA)
	_, keyPath := writePair(t, dirB)

	if _, err := NewCertificateReloader(certPath, keyPath, 0); err == nil {
		t.Fatal("NewCertificateReloader returned nil for a certificate and key that do not match, want a refusal")
	}
}

func TestCertificateReloaderServesTheConfiguredCertificate(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := writePair(t, dir)

	reloader, err := NewCertificateReloader(certPath, keyPath, 0)
	if err != nil {
		t.Fatalf("NewCertificateReloader: %v", err)
	}
	served, err := reloader.GetCertificate(&tls.ClientHelloInfo{ServerName: "localhost"})
	if err != nil {
		t.Fatalf("GetCertificate: %v", err)
	}
	if got := serial(t, served); got == "" {
		t.Fatal("served certificate has no serial")
	}
}

// `tailscale cert` renews on disk. A relay that has to be restarted to notice is
// an outage on renewal day, so the reloader must pick up a replaced pair.
func TestCertificateReloaderPicksUpARenewalWithoutRestart(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := writePair(t, dir)

	reloader, err := NewCertificateReloader(certPath, keyPath, 0)
	if err != nil {
		t.Fatalf("NewCertificateReloader: %v", err)
	}
	before, err := reloader.GetCertificate(&tls.ClientHelloInfo{ServerName: "localhost"})
	if err != nil {
		t.Fatalf("GetCertificate: %v", err)
	}

	renewed := t.TempDir()
	newCert, newKey := writePair(t, renewed)
	copyFile(t, newCert, certPath)
	copyFile(t, newKey, keyPath)

	after, err := reloader.GetCertificate(&tls.ClientHelloInfo{ServerName: "localhost"})
	if err != nil {
		t.Fatalf("GetCertificate after renewal: %v", err)
	}
	if serial(t, before) == serial(t, after) {
		t.Fatal("reloader kept serving the old certificate after both files were replaced")
	}
}

// A renewal is not atomic: for a moment the certificate file may be half written
// or the two files may disagree. Failing the handshake in that window would turn
// a renewal into an outage, so the last known-good pair must keep serving.
func TestCertificateReloaderKeepsTheLastGoodPairWhenAReadFails(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := writePair(t, dir)

	reloader, err := NewCertificateReloader(certPath, keyPath, 0)
	if err != nil {
		t.Fatalf("NewCertificateReloader: %v", err)
	}
	before, err := reloader.GetCertificate(&tls.ClientHelloInfo{ServerName: "localhost"})
	if err != nil {
		t.Fatalf("GetCertificate: %v", err)
	}

	if err := os.WriteFile(certPath, []byte("-----BEGIN CERTIFICATE-----\ntruncated"), 0o644); err != nil {
		t.Fatalf("truncate cert: %v", err)
	}

	after, err := reloader.GetCertificate(&tls.ClientHelloInfo{ServerName: "localhost"})
	if err != nil {
		t.Fatalf("GetCertificate over a half-written renewal returned %v, want the last good certificate", err)
	}
	if serial(t, before) != serial(t, after) {
		t.Fatal("reloader did not keep the last good certificate across an unreadable file")
	}
}

// The interval is what keeps a per-handshake re-read off the hot path. Inside it
// the reloader must not touch the filesystem again.
func TestCertificateReloaderHonoursItsRecheckInterval(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := writePair(t, dir)

	reloader, err := NewCertificateReloader(certPath, keyPath, time.Hour)
	if err != nil {
		t.Fatalf("NewCertificateReloader: %v", err)
	}
	before, err := reloader.GetCertificate(&tls.ClientHelloInfo{ServerName: "localhost"})
	if err != nil {
		t.Fatalf("GetCertificate: %v", err)
	}

	renewed := t.TempDir()
	newCert, newKey := writePair(t, renewed)
	copyFile(t, newCert, certPath)
	copyFile(t, newKey, keyPath)

	after, err := reloader.GetCertificate(&tls.ClientHelloInfo{ServerName: "localhost"})
	if err != nil {
		t.Fatalf("GetCertificate: %v", err)
	}
	if serial(t, before) != serial(t, after) {
		t.Fatal("reloader re-read the pair inside its recheck interval")
	}
}

func TestCertificateReloaderIsSafeUnderConcurrentHandshakes(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := writePair(t, dir)

	reloader, err := NewCertificateReloader(certPath, keyPath, 0)
	if err != nil {
		t.Fatalf("NewCertificateReloader: %v", err)
	}

	var group sync.WaitGroup
	for i := 0; i < 32; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, err := reloader.GetCertificate(&tls.ClientHelloInfo{ServerName: "localhost"}); err != nil {
				t.Errorf("GetCertificate: %v", err)
			}
		}()
	}
	group.Wait()
}

func copyFile(t *testing.T, from, to string) {
	t.Helper()
	bytes, err := os.ReadFile(from)
	if err != nil {
		t.Fatalf("read %s: %v", from, err)
	}
	if err := os.WriteFile(to, bytes, 0o600); err != nil {
		t.Fatalf("write %s: %v", to, err)
	}
}
