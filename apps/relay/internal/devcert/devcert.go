// Package devcert generates self-signed TLS key pairs for local development and
// for the test suites that need a relay listening on HTTPS.
//
// It is NOT the production certificate story. On the deployment target - a
// Tailscale tailnet - certificates come from `tailscale cert`, which issues real
// Let's Encrypt certificates for `<host>.<tailnet>.ts.net` names and renews them
// on disk. The relay only ever reads the pair; see internal/tlsx.
//
// Nothing on the relay's serving path imports this package: it is reachable only
// from tests and from the `gencert` helper command next to it.
package devcert

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"time"
)

// Pair is a PEM-encoded certificate and its private key. The key bytes are
// returned to the caller so they can be written to a file with restrictive
// permissions; they are never logged, printed or embedded in an error.
type Pair struct {
	CertPEM []byte
	KeyPEM  []byte
}

// Generate produces a self-signed P-256 certificate valid for the given hosts.
// A host that parses as an IP address becomes an IP SAN, anything else a DNS
// SAN. validFor bounds the certificate's lifetime.
func Generate(hosts []string, validFor time.Duration) (Pair, error) {
	if len(hosts) == 0 {
		return Pair{}, errors.New("devcert: at least one host is required")
	}
	if validFor <= 0 {
		return Pair{}, errors.New("devcert: validFor must be positive")
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return Pair{}, fmt.Errorf("devcert: generate key: %w", err)
	}

	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		return Pair{}, fmt.Errorf("devcert: generate serial: %w", err)
	}

	now := time.Now()
	template := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: hosts[0], Organization: []string{"Echolet relay (development)"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(validFor),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	for _, host := range hosts {
		if ip := net.ParseIP(host); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
			continue
		}
		template.DNSNames = append(template.DNSNames, host)
	}

	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return Pair{}, fmt.Errorf("devcert: create certificate: %w", err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return Pair{}, fmt.Errorf("devcert: marshal key: %w", err)
	}

	return Pair{
		CertPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		KeyPEM:  pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}),
	}, nil
}
