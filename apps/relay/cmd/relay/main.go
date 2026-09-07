package main

import (
	"log/slog"
	"os"

	"echolet/apps/relay/internal/api/router"
	"echolet/apps/relay/internal/config"
	"echolet/apps/relay/internal/logging"
	"echolet/apps/relay/internal/server"
	"echolet/apps/relay/internal/storage"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("Failed to load config", "error", err)
		os.Exit(1)
	}

	logger := logging.NewLogger(cfg.LogLevel)
	slog.SetDefault(logger)

	st, err := storage.NewStorage(cfg.DataDir)
	if err != nil {
		slog.Error("Failed to open storage", "error", err)
		os.Exit(1)
	}
	defer st.Close()

	r := router.NewRouter(cfg, st)

	// A TLS configuration that cannot be honoured stops the relay here. It must
	// never degrade into plain HTTP: the CLI refuses a non-loopback relay URL
	// that is not HTTPS, so an operator whose relay came up on plain HTTP after
	// asking for TLS would be told nothing while every envelope crossed the
	// network in the clear.
	srv, err := server.New(cfg, r)
	if err != nil {
		slog.Error("Failed to configure server", "error", err)
		os.Exit(1)
	}

	// Paths only, never contents: the certificate is public, the key is not.
	slog.Info("Starting relay server", "addr", cfg.HTTPAddr, "scheme", srv.Scheme(),
		"tls_cert_file", cfg.TLSCertFile, "tls_key_file", cfg.TLSKeyFile)
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("Failed to start server", "error", err)
		os.Exit(1)
	}
}
