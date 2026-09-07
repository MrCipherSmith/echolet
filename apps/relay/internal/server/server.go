// Package server turns a validated configuration and a handler into the one
// listening HTTP server the relay runs.
//
// It exists for two reasons a bare http.ListenAndServe cannot cover. First, that
// helper sets no timeouts at all, so a relay reachable from outside its host can
// be held open indefinitely by idle or deliberately slow connections. Second,
// whether the relay serves HTTPS is decided here, once, from the configuration -
// and a TLS configuration that cannot be honoured is an error returned to main,
// never a fallback to plain HTTP.
package server

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"

	"echolet/apps/relay/internal/config"
	"echolet/apps/relay/internal/tlsx"
)

// Timeouts. A plain ListenAndServe leaves all four at zero, meaning "no limit".
//
// ReadHeaderTimeout is the slowloris bound and is deliberately short: no honest
// client needs ten seconds to send request headers. The other three are generous
// because the relay's own bounds already cap the work - a poll page is bounded by
// ECHOLET_MAX_MAILBOX_BATCH and ECHOLET_MAX_MESSAGE_BYTES, and a flooded mailbox
// walk downloads several hundred kilobytes per page - and a timeout tight enough
// to be interesting would fail a legitimate large page on a slow link instead.
const (
	ReadHeaderTimeout = 10 * time.Second
	ReadTimeout       = 60 * time.Second
	WriteTimeout      = 120 * time.Second
	IdleTimeout       = 120 * time.Second
	MaxHeaderBytes    = 64 << 10
)

// Server is the relay's listening server plus the fact of whether it is serving
// TLS. The embedded *http.Server is reachable for inspection but the lifecycle
// goes through the methods here, so the TLS and plain paths cannot diverge.
type Server struct {
	inner      *http.Server
	tlsEnabled bool
}

// New builds the server. It returns an error - and no server - when TLS is
// configured but cannot be honoured: a half-configured pair, a missing or
// unreadable file, a malformed PEM, or a key that does not match its
// certificate. None of those fall back to plain HTTP.
func New(cfg config.Config, handler http.Handler) (*Server, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	inner := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: ReadHeaderTimeout,
		ReadTimeout:       ReadTimeout,
		WriteTimeout:      WriteTimeout,
		IdleTimeout:       IdleTimeout,
		MaxHeaderBytes:    MaxHeaderBytes,
	}
	if !cfg.TLSEnabled() {
		return &Server{inner: inner}, nil
	}

	reloader, err := tlsx.NewCertificateReloader(
		cfg.TLSCertFile,
		cfg.TLSKeyFile,
		time.Duration(cfg.TLSReloadIntervalSeconds)*time.Second,
	)
	if err != nil {
		return nil, err
	}
	inner.TLSConfig = tlsx.ServerTLSConfig(reloader)
	return &Server{inner: inner, tlsEnabled: true}, nil
}

// TLSEnabled reports whether this server serves HTTPS.
func (s *Server) TLSEnabled() bool { return s.tlsEnabled }

// Scheme is the URL scheme this server answers on, for logging.
func (s *Server) Scheme() string {
	if s.tlsEnabled {
		return "https"
	}
	return "http"
}

// HTTPServer exposes the configured server for inspection.
func (s *Server) HTTPServer() *http.Server { return s.inner }

// ListenAndServe binds the configured address and serves until the listener is
// closed.
func (s *Server) ListenAndServe() error {
	listener, err := net.Listen("tcp", s.inner.Addr)
	if err != nil {
		return err
	}
	return s.Serve(listener)
}

// Serve serves on an already-bound listener. The certificate comes from the
// reloader through TLSConfig.GetCertificate, so the empty file names here are
// correct rather than an omission.
func (s *Server) Serve(listener net.Listener) error {
	if s.tlsEnabled {
		return s.inner.ServeTLS(listener, "", "")
	}
	return s.inner.Serve(listener)
}

// Close stops the server immediately. http.ErrServerClosed is the expected
// outcome of a stop, not a failure.
func (s *Server) Close() error {
	if err := s.inner.Close(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// Shutdown stops accepting connections and waits for in-flight requests.
func (s *Server) Shutdown(ctx context.Context) error {
	return s.inner.Shutdown(ctx)
}
