package main

import (
	"log/slog"
	"net/http"
	"os"

	"echolet/apps/relay/internal/api/router"
	"echolet/apps/relay/internal/config"
	"echolet/apps/relay/internal/logging"
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

	slog.Info("Starting relay server", "addr", cfg.HTTPAddr)
	if err := http.ListenAndServe(cfg.HTTPAddr, r); err != nil {
		slog.Error("Failed to start server", "error", err)
		os.Exit(1)
	}
}
