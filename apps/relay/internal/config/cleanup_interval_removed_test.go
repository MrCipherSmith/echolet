package config

import (
	"reflect"
	"strings"
	"testing"
)

// Flow 003, T33: the cleanup interval is not a configuration.
//
// ECHOLET_CLEANUP_INTERVAL_SECONDS was removed from every operator-facing file in
// T28 - both compose files, run-relay.sh, all three env examples, OPS-23 and the
// requirements documents - because the service it configures does no work:
// CleanupService.runCleanup() is two slog.Debug calls, and retention is Badger's
// own TTL. What T28 could not do, being documentation-scoped, was remove the
// FIELD, so the binary still declared the variable, still applied a default to it,
// and still logged an interval at startup that no document mentions. An operator
// reading the relay's own log would find a knob the deployment surface denies
// exists, and one who set the variable anyway would be silently obeyed by a
// ticker that sweeps nothing.
//
// The SERVICE stays. Its Stop() is what puts the ticker goroutine inside the
// relay's shutdown sequence so nothing is still writing when Badger closes
// (service/cleanup_service_stop_test.go, cmd/relay/main.go). Only the
// configuration is removed; the ticker's period now belongs to the service that
// owns it.
func TestTheConfigurationSurfaceOffersNoCleanupInterval(t *testing.T) {
	const removedVariable = "ECHOLET_CLEANUP_INTERVAL_SECONDS"

	configType := reflect.TypeOf(Config{})
	for index := 0; index < configType.NumField(); index++ {
		field := configType.Field(index)

		if strings.Contains(field.Tag.Get("env"), removedVariable) {
			t.Fatalf("Config.%s still declares %s. The variable is gone from every operator-facing file, and the "+
				"service it configured does no work, so a field that still reads it can only mislead: it puts an "+
				"interval in the relay's startup log that no document mentions, and it silently accepts a value "+
				"from an operator that changes nothing they can observe",
				field.Name, removedVariable)
		}
		if strings.Contains(field.Name, "Cleanup") {
			t.Fatalf("Config.%s is still a cleanup knob (tag %q). Retention is Badger's own TTL; the cleanup "+
				"service's ticker period is the service's business, not a deployment's",
				field.Name, field.Tag.Get("env"))
		}
	}
}

// TestLoadIgnoresACleanupIntervalAnOperatorSetsAnyway pins the consequence of the
// removal for a host whose .env file still carries the line. A stale variable
// must be inert, never a startup failure: the relays this repository deploys to
// are live, and removing a knob must not be able to stop one from coming back up.
//
// This was green before the field was removed and is green after; it is a
// regression guard on the removal, not the test that drove it.
func TestLoadIgnoresACleanupIntervalAnOperatorSetsAnyway(t *testing.T) {
	clearTLSEnv(t)
	t.Setenv("ECHOLET_CLEANUP_INTERVAL_SECONDS", "3600")

	if _, err := Load(); err != nil {
		t.Fatalf("Load() returned %v with a stale ECHOLET_CLEANUP_INTERVAL_SECONDS still exported, want nil; a "+
			"removed knob must be inert on a host that still sets it, not a reason the relay stops starting", err)
	}
}
