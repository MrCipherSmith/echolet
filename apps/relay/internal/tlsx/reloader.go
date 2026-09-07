// Package tlsx holds the relay's TLS serving pieces: a certificate pair read
// from disk that can be replaced under a running process, and the server-side
// tls.Config built around it.
//
// The relay never obtains a certificate itself. On the deployment target,
// `tailscale cert` issues and periodically renews a real certificate for a
// `<host>.<tailnet>.ts.net` name and writes the pair to disk; ACME lives there,
// not here. What the relay owes that arrangement is the ability to notice the
// renewal without being restarted, which is what CertificateReloader is for.
package tlsx

import (
	"crypto/sha256"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"
)

// CertificateReloader serves one certificate pair and re-reads it from disk when
// the files change, so a renewal does not require a restart.
//
// Change is detected by SHA-256 over the file bytes rather than by modification
// time: a renewal that rewrites a file with a preserved or coarse timestamp is
// still a different certificate, and a touched file with identical bytes is not.
// Re-reading is throttled by interval so a handshake storm cannot turn into a
// filesystem storm.
type CertificateReloader struct {
	certPath string
	keyPath  string
	interval time.Duration
	now      func() time.Time

	mu        sync.Mutex
	current   *tls.Certificate
	digest    [sha256.Size]byte
	checkedAt time.Time
}

// NewCertificateReloader loads the pair once, eagerly. A missing, unreadable,
// malformed or mismatched pair is an error here, at startup, where an operator
// sees it - never a silent fallback to plain HTTP.
func NewCertificateReloader(certPath, keyPath string, interval time.Duration) (*CertificateReloader, error) {
	if certPath == "" || keyPath == "" {
		return nil, errors.New("tlsx: both a certificate path and a key path are required")
	}
	if interval < 0 {
		return nil, fmt.Errorf("tlsx: recheck interval must not be negative, got %s", interval)
	}
	reloader := &CertificateReloader{certPath: certPath, keyPath: keyPath, interval: interval, now: time.Now}
	certificate, digest, err := reloader.read()
	if err != nil {
		return nil, err
	}
	reloader.current, reloader.digest, reloader.checkedAt = certificate, digest, reloader.now()
	return reloader, nil
}

// GetCertificate is the tls.Config hook. It never fails once startup succeeded:
// a renewal is not atomic, so a read that fails mid-rewrite keeps the last good
// pair serving and logs a warning. Turning a half-written file into a handshake
// failure would convert a renewal into an outage, which is exactly the failure
// this type exists to prevent.
func (r *CertificateReloader) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.current != nil && r.now().Sub(r.checkedAt) < r.interval {
		return r.current, nil
	}
	r.checkedAt = r.now()

	certificate, digest, err := r.read()
	if err != nil {
		if r.current == nil {
			return nil, err
		}
		// Paths only. The certificate is public but the key is not, and neither
		// file's contents ever reach a log line.
		slog.Warn("failed to reload TLS certificate, keeping the last good pair",
			"cert_file", r.certPath, "key_file", r.keyPath, "error", err)
		return r.current, nil
	}
	if digest != r.digest {
		slog.Info("reloaded TLS certificate", "cert_file", r.certPath, "key_file", r.keyPath)
		r.current, r.digest = certificate, digest
	}
	return r.current, nil
}

// read loads and parses the pair and returns a digest over both files' bytes.
// Errors name the paths and the failure, never the bytes.
func (r *CertificateReloader) read() (*tls.Certificate, [sha256.Size]byte, error) {
	var digest [sha256.Size]byte

	certPEM, err := os.ReadFile(r.certPath)
	if err != nil {
		return nil, digest, fmt.Errorf("tlsx: read certificate %s: %w", r.certPath, err)
	}
	keyPEM, err := os.ReadFile(r.keyPath)
	if err != nil {
		return nil, digest, fmt.Errorf("tlsx: read key %s: %w", r.keyPath, err)
	}
	certificate, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, digest, fmt.Errorf("tlsx: load key pair (%s, %s): %w", r.certPath, r.keyPath, err)
	}

	hash := sha256.New()
	hash.Write(certPEM)
	hash.Write(keyPEM)
	copy(digest[:], hash.Sum(nil))
	return &certificate, digest, nil
}
