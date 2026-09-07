package tlsx

import "crypto/tls"

// ServerTLSConfig builds the relay's server-side TLS configuration around a
// reloader.
//
// MinVersion is TLS 1.2. TLS 1.0 and 1.1 are deprecated by RFC 8996 and Go will
// negotiate 1.3 with every client this prototype has (Go's own client, Node's
// undici, curl), so 1.2 is the floor rather than the expectation. It is not
// raised to 1.3 because that floor buys nothing here - the peers already
// negotiate 1.3 - while refusing a 1.2-only client outright.
//
// CipherSuites is listed explicitly and covers TLS 1.2 only; Go ignores this
// field for TLS 1.3, whose suites are not configurable. The list is AEAD and
// forward-secret only, which drops the CBC-mode suites Go's own default still
// offers for interoperability.
func ServerTLSConfig(reloader *CertificateReloader) *tls.Config {
	return &tls.Config{
		GetCertificate: reloader.GetCertificate,
		MinVersion:     tls.VersionTLS12,
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
		},
		CurvePreferences: []tls.CurveID{tls.X25519, tls.CurveP256, tls.CurveP384},
		NextProtos:       []string{"h2", "http/1.1"},
	}
}
