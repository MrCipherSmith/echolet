package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"echolet/apps/relay/internal/api/router"
	"echolet/apps/relay/internal/config"
	"echolet/apps/relay/internal/logging"
	"echolet/apps/relay/internal/server"
	"echolet/apps/relay/internal/storage"
)

// drainTimeout bounds how long an already-accepted request may keep the relay
// alive after a stop signal.
//
// The ceiling is not taste: `docker stop` sends SIGTERM and SIGKILLs after a
// 10s grace period by default, and a relay killed that way reports a non-zero
// exit for that reason alone - the exact symptom this shutdown path exists to
// remove. The whole sequence (drain, then close Badger) has to fit inside that
// grace period with room to spare, so the drain gets 5s and leaves the rest to
// the store close, which takes milliseconds. A handler still running at the
// deadline does not get to extend it: the connections are closed and the store
// is closed anyway, because a slow client must never be able to make an
// ordinary operator stop look like a crash.
const drainTimeout = 5 * time.Second

func main() {
	os.Exit(run())
}

// run is main's body with a return value instead of os.Exit, so the shutdown
// ordering below is expressed once and every path reports its own status.
func run() int {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("Failed to load config", "error", err)
		return 1
	}

	logger := logging.NewLogger(cfg.LogLevel)
	slog.SetDefault(logger)

	// The handler is installed before Badger is opened, not after the listener
	// is up. Without it the default disposition for SIGTERM is death, and a
	// signal that lands during startup - a container stopped seconds after it
	// was started, a supervisor giving up on a slow boot - would abandon a data
	// directory that had just been locked and had a memtable write-ahead log
	// written into it. The buffer of two is what makes a second signal
	// observable rather than dropped; see the escalation below.
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)

	st, err := storage.NewStorage(cfg.DataDir)
	if err != nil {
		slog.Error("Failed to open storage", "error", err)
		return 1
	}

	r := router.NewRouter(cfg, st)

	// A TLS configuration that cannot be honoured stops the relay here. It must
	// never degrade into plain HTTP: the CLI refuses a non-loopback relay URL
	// that is not HTTPS, so an operator whose relay came up on plain HTTP after
	// asking for TLS would be told nothing while every envelope crossed the
	// network in the clear.
	srv, err := server.New(cfg, r)
	if err != nil {
		slog.Error("Failed to configure server", "error", err)
		return stopBackgroundWorkAndCloseStorage(r, st, 1)
	}

	// Paths only, never contents: the certificate is public, the key is not.
	slog.Info("Starting relay server", "addr", cfg.HTTPAddr, "scheme", srv.Scheme(),
		"tls_cert_file", cfg.TLSCertFile, "tls_key_file", cfg.TLSKeyFile)

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.ListenAndServe() }()

	select {
	case err := <-serveErr:
		// The server stopped without being asked to. Binding a taken port and a
		// TLS handshake configuration that only fails at Serve time both arrive
		// here, and both are startup failures.
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("Failed to start server", "error", err)
			return stopBackgroundWorkAndCloseStorage(r, st, 1)
		}
		return stopBackgroundWorkAndCloseStorage(r, st, 0)
	case sig := <-signals:
		// The signal name is operational fact, not request content. Nothing
		// about the requests being drained is logged here or below.
		slog.Info("Shutdown signal received; draining in-flight requests",
			"signal", sig.String(), "drain_timeout", drainTimeout.String())
	}

	// The order below is the fix, not an implementation detail.
	//
	//  1. Shutdown closes the listeners first, so no new connection is accepted
	//     from the moment the signal is handled.
	//  2. It then waits for requests already being served to finish, so an
	//     operator stop completes work in flight instead of cutting it.
	//  3. Only once that has finished - or been forced to finish - is the
	//     router's background work stopped and Badger closed. Closing the store
	//     underneath a running handler would be a worse defect than the one this
	//     replaces: the handler's write would fail against a closing database
	//     instead of simply being drained. The cleanup ticker belongs to the
	//     same step for the same reason - it is a writer on a timer, and a
	//     drained server with a ticker still running is the hazard this order
	//     exists to remove, only harder to see.
	//  4. Then, and only then, exit 0, because an operator stop is a success.
	ctx, cancel := context.WithTimeout(context.Background(), drainTimeout)
	defer cancel()

	drained := make(chan error, 1)
	go func() { drained <- srv.Shutdown(ctx) }()

	select {
	case err := <-drained:
		if err != nil {
			// Almost always the drain deadline. The remaining connections are
			// closed so that no handler outlives the store; the exit status is
			// still 0, because a client that would not finish in time is not
			// the operator's stop failing.
			slog.Warn("Drain did not complete; closing remaining connections",
				"error", err, "drain_timeout", drainTimeout.String())
			if cerr := srv.Close(); cerr != nil {
				slog.Warn("Closing remaining connections failed", "error", cerr)
			}
		} else {
			slog.Info("In-flight requests drained")
		}
	case sig := <-signals:
		// A second signal is an operator saying "stop waiting", so it abandons
		// the drain - but it does not abandon the store. Connections are closed
		// immediately, the drain is still collected so the store is not closed
		// while Shutdown is running, and the sequence then continues into the
		// same clean Close below. Every later signal is dropped by the buffered
		// channel on purpose: past this point there is nothing left to wait for
		// and interrupting the store close is exactly the damage being avoided.
		slog.Warn("Second shutdown signal received; closing connections immediately",
			"signal", sig.String())
		if cerr := srv.Close(); cerr != nil {
			slog.Warn("Closing remaining connections failed", "error", cerr)
		}
		if err := <-drained; err != nil {
			slog.Warn("Drain did not complete", "error", err)
		}
	}

	// Serve returns as soon as its listener is closed, which Shutdown does
	// before it waits for anything, so this does not extend the stop.
	if err := <-serveErr; err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Warn("Server stopped with an error", "error", err)
	}

	return stopBackgroundWorkAndCloseStorage(r, st, 0)
}

// stopBackgroundWorkAndCloseStorage ends everything the router runs on its own
// schedule, then closes Badger, and returns the exit status to use.
//
// The two are one step because their order is a correctness property, not a
// preference: the cleanup ticker can write, so it has to be gone before the
// store it writes into is closed - the same argument step 3 above makes about
// in-flight handlers. Every path that closes the store goes through here,
// including the two startup failures, because the router starts its ticker
// before the server is even configured and a failure between those two points
// would otherwise abandon a running goroutine over a closing database.
func stopBackgroundWorkAndCloseStorage(r *router.Router, st *storage.Storage, code int) int {
	r.Stop()
	return closeStorage(st, code)
}

// closeStorage closes Badger and returns the exit status to use.
//
// A close that fails is reported as a failure: an unflushed memtable is the
// durability problem this whole path exists to prevent, and silently exiting 0
// after one would hide it from the same supervisor the exit status is for.
func closeStorage(st *storage.Storage, code int) int {
	if err := st.Close(); err != nil {
		slog.Error("Failed to close storage", "error", err)
		return 1
	}
	slog.Info("Storage closed")
	return code
}
