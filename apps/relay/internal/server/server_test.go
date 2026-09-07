package server

import (
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"echolet/apps/relay/internal/config"
	"echolet/apps/relay/internal/devcert"
)

func handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"ok":true}`)
	})
}

func pair(t *testing.T) (certPath, keyPath string, pool *x509.CertPool) {
	t.Helper()
	generated, err := devcert.Generate([]string{"localhost", "127.0.0.1", "::1"}, time.Hour)
	if err != nil {
		t.Fatalf("devcert.Generate: %v", err)
	}
	dir := t.TempDir()
	certPath, keyPath = filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certPath, generated.CertPEM, 0o644); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	if err := os.WriteFile(keyPath, generated.KeyPEM, 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	pool = x509.NewCertPool()
	if !pool.AppendCertsFromPEM(generated.CertPEM) {
		t.Fatal("could not build a trust pool from the generated certificate")
	}
	return certPath, keyPath, pool
}

func base(t *testing.T) config.Config {
	t.Helper()
	return config.Config{HTTPAddr: "127.0.0.1:0", TLSReloadIntervalSeconds: 60}
}

// A plain ListenAndServe sets no timeouts at all, which is how a relay that is
// reachable from outside its host gets held open by idle or slow connections.
func TestNewAppliesTimeoutsToThePlainHTTPServer(t *testing.T) {
	srv, err := New(base(t), handler())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if srv.TLSEnabled() {
		t.Fatal("TLSEnabled() = true with no certificate configured, want false")
	}
	inner := srv.HTTPServer()
	for name, value := range map[string]time.Duration{
		"ReadHeaderTimeout": inner.ReadHeaderTimeout,
		"ReadTimeout":       inner.ReadTimeout,
		"WriteTimeout":      inner.WriteTimeout,
		"IdleTimeout":       inner.IdleTimeout,
	} {
		if value <= 0 {
			t.Fatalf("%s = %v, want a positive timeout", name, value)
		}
	}
	if inner.TLSConfig != nil {
		t.Fatal("TLSConfig set on a plain HTTP server")
	}
}

func TestNewRefusesAMissingCertificateFileRatherThanFallingBackToPlainHTTP(t *testing.T) {
	certPath, keyPath, _ := pair(t)
	cfg := base(t)
	cfg.TLSCertFile = filepath.Join(filepath.Dir(certPath), "absent.pem")
	cfg.TLSKeyFile = keyPath

	srv, err := New(cfg, handler())
	if err == nil {
		t.Fatalf("New returned a server (TLS=%v) for a missing certificate file, want a refusal", srv.TLSEnabled())
	}
	if !strings.Contains(err.Error(), "absent.pem") {
		t.Fatalf("error %q does not name the offending path", err.Error())
	}
}

func TestNewRefusesACertificateWithoutAKey(t *testing.T) {
	certPath, _, _ := pair(t)
	cfg := base(t)
	cfg.TLSCertFile = certPath

	if _, err := New(cfg, handler()); err == nil {
		t.Fatal("New returned nil for a certificate with no key, want a refusal")
	}
}

func TestNewRefusesAKeyWithoutACertificate(t *testing.T) {
	_, keyPath, _ := pair(t)
	cfg := base(t)
	cfg.TLSKeyFile = keyPath

	if _, err := New(cfg, handler()); err == nil {
		t.Fatal("New returned nil for a key with no certificate, want a refusal")
	}
}

func TestNewSetsAModernMinimumTLSVersion(t *testing.T) {
	certPath, keyPath, _ := pair(t)
	cfg := base(t)
	cfg.TLSCertFile, cfg.TLSKeyFile = certPath, keyPath

	srv, err := New(cfg, handler())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if !srv.TLSEnabled() {
		t.Fatal("TLSEnabled() = false with both paths set, want true")
	}
	tlsConfig := srv.HTTPServer().TLSConfig
	if tlsConfig == nil {
		t.Fatal("TLSConfig is nil on a TLS-configured server")
	}
	if tlsConfig.MinVersion < tls.VersionTLS12 {
		t.Fatalf("MinVersion = %#x, want at least TLS 1.2 (%#x)", tlsConfig.MinVersion, tls.VersionTLS12)
	}
	if tlsConfig.GetCertificate == nil {
		t.Fatal("GetCertificate is nil, so a renewed certificate could never be picked up")
	}
}

func start(t *testing.T, srv *Server) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() { _ = srv.Serve(listener) }()
	t.Cleanup(func() { _ = srv.Close() })
	return listener.Addr().String()
}

func TestServerServesHTTPSAndNotPlainHTTP(t *testing.T) {
	certPath, keyPath, pool := pair(t)
	cfg := base(t)
	cfg.TLSCertFile, cfg.TLSKeyFile = certPath, keyPath

	srv, err := New(cfg, handler())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	address := start(t, srv)

	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}, Timeout: 5 * time.Second}
	response, err := client.Get("https://" + address + "/health")
	if err != nil {
		t.Fatalf("HTTPS request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("HTTPS status = %d, want 200", response.StatusCode)
	}
	if response.TLS == nil || response.TLS.Version < tls.VersionTLS12 {
		t.Fatal("response was not carried over TLS 1.2 or better")
	}

	// Go's TLS listener answers a plaintext request with a bare 400 rather than
	// dropping it. What matters is that it never serves the relay's API in the
	// clear, so a client cannot be silently downgraded.
	plain := &http.Client{Timeout: 5 * time.Second}
	downgraded, err := plain.Get("http://" + address + "/health")
	if err == nil {
		defer downgraded.Body.Close()
		if downgraded.StatusCode/100 == 2 {
			t.Fatalf("the TLS listener answered a plain HTTP request with %d, so a client could be silently downgraded", downgraded.StatusCode)
		}
		body, _ := io.ReadAll(downgraded.Body)
		if !strings.Contains(string(body), "HTTP request to an HTTPS server") {
			t.Fatalf("plain HTTP answer %d did not identify the port as HTTPS-only", downgraded.StatusCode)
		}
	}
}

func TestServerRefusesATLS11Client(t *testing.T) {
	certPath, keyPath, pool := pair(t)
	cfg := base(t)
	cfg.TLSCertFile, cfg.TLSKeyFile = certPath, keyPath

	srv, err := New(cfg, handler())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	address := start(t, srv)

	legacy := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		RootCAs:    pool,
		MinVersion: tls.VersionTLS10,
		MaxVersion: tls.VersionTLS11,
	}}, Timeout: 5 * time.Second}
	if _, err := legacy.Get("https://" + address + "/health"); err == nil {
		t.Fatal("a TLS 1.1 client completed a handshake, want it refused")
	}
}

func TestPlainServerStillServesLoopbackHTTP(t *testing.T) {
	srv, err := New(base(t), handler())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	address := start(t, srv)

	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Get("http://" + address + "/health")
	if err != nil {
		t.Fatalf("plain HTTP request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("plain HTTP status = %d, want 200", response.StatusCode)
	}
}
