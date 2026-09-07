package config

import (
	"os"
	"strings"
	"testing"
)

// The relay serves plain HTTP only on loopback; the CLI refuses a non-loopback
// relay URL that is not HTTPS (apps/cli/src/runtime/config.ts). TLS is therefore
// a precondition for any remote relay, and the one failure mode that must never
// exist is a half-configured pair that quietly keeps serving plain HTTP: the
// operator would believe the relay is protected while it is not. These tests pin
// that Load() refuses the half-configured pair instead.

// t.Setenv registers the restore, os.Unsetenv then removes the variable outright
// so the test observes the real "operator set nothing" case rather than an empty
// string the env decoder may or may not treat as the default.
func clearTLSEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{"ECHOLET_TLS_CERT_FILE", "ECHOLET_TLS_KEY_FILE", "ECHOLET_TLS_RELOAD_INTERVAL_SECONDS"} {
		t.Setenv(key, "")
		if err := os.Unsetenv(key); err != nil {
			t.Fatalf("unset %s: %v", key, err)
		}
	}
}

func TestLoadWithoutTLSPathsKeepsPlainHTTP(t *testing.T) {
	clearTLSEnv(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned %v, want nil", err)
	}
	if cfg.TLSEnabled() {
		t.Fatal("TLSEnabled() = true with neither path set, want false")
	}
}

func TestLoadWithBothTLSPathsEnablesTLS(t *testing.T) {
	clearTLSEnv(t)
	t.Setenv("ECHOLET_TLS_CERT_FILE", "/etc/echolet/cert.pem")
	t.Setenv("ECHOLET_TLS_KEY_FILE", "/etc/echolet/key.pem")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned %v, want nil", err)
	}
	if !cfg.TLSEnabled() {
		t.Fatal("TLSEnabled() = false with both paths set, want true")
	}
	if cfg.TLSCertFile != "/etc/echolet/cert.pem" || cfg.TLSKeyFile != "/etc/echolet/key.pem" {
		t.Fatalf("TLS paths not carried through: cert=%q key=%q", cfg.TLSCertFile, cfg.TLSKeyFile)
	}
}

func TestLoadRefusesCertificateWithoutKey(t *testing.T) {
	clearTLSEnv(t)
	t.Setenv("ECHOLET_TLS_CERT_FILE", "/etc/echolet/cert.pem")

	_, err := Load()
	if err == nil {
		t.Fatal("Load() returned nil for a certificate without a key, want a refusal")
	}
	for _, want := range []string{"ECHOLET_TLS_CERT_FILE", "ECHOLET_TLS_KEY_FILE"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not name %s", err.Error(), want)
		}
	}
}

func TestLoadRefusesKeyWithoutCertificate(t *testing.T) {
	clearTLSEnv(t)
	t.Setenv("ECHOLET_TLS_KEY_FILE", "/etc/echolet/key.pem")

	_, err := Load()
	if err == nil {
		t.Fatal("Load() returned nil for a key without a certificate, want a refusal")
	}
	for _, want := range []string{"ECHOLET_TLS_CERT_FILE", "ECHOLET_TLS_KEY_FILE"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not name %s", err.Error(), want)
		}
	}
}

func TestLoadRefusesNegativeTLSReloadInterval(t *testing.T) {
	clearTLSEnv(t)
	t.Setenv("ECHOLET_TLS_CERT_FILE", "/etc/echolet/cert.pem")
	t.Setenv("ECHOLET_TLS_KEY_FILE", "/etc/echolet/key.pem")
	t.Setenv("ECHOLET_TLS_RELOAD_INTERVAL_SECONDS", "-1")

	if _, err := Load(); err == nil {
		t.Fatal("Load() returned nil for a negative reload interval, want a refusal")
	}
}

func TestTLSReloadIntervalHasAPositiveDefault(t *testing.T) {
	clearTLSEnv(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned %v, want nil", err)
	}
	if cfg.TLSReloadIntervalSeconds <= 0 {
		t.Fatalf("TLSReloadIntervalSeconds = %d, want a positive default so a renewed certificate is picked up", cfg.TLSReloadIntervalSeconds)
	}
}
