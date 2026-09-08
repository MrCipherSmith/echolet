package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"

	"echolet/apps/relay/internal/protocol"
)

// Residual RI-09, the startup half (flow 003 T11 §1.3, pinned by T21).
//
// The maximum ciphertext size is a PROTOCOL constant - protocol.MaxMessageBytes,
// mirroring LIMITS.MAX_MESSAGE_BYTES in packages/protocol - agreed in advance by
// both sides and never negotiated on the wire. A client sizes its poll-response
// bound from it; this relay sizes its poll byte budget from it. A deployment may
// configure LESS, because a relay stricter than its clients is merely stricter.
// It may not configure MORE: the relay would accept an envelope, store it, and
// answer every poll with a body the recipient refuses in full, so nothing is ever
// acknowledged and the mailbox is undeliverable with both ends looking healthy.
//
// This is the behaviour that replaced the scenario the retired
// TestMaximumSizeEnvelopeIsDeliverableAtRaisedMaxMessageBytes used to drive
// (api/handler/mailbox_poll_byte_budget_derivation_test.go): a relay configured
// above the protocol maximum is not a relay whose delivery can be tested, it is a
// relay that does not start. The "several times the protocol one" case below is
// that configuration, now pinned as the refusal it became.
//
// Every value is expressed relative to protocol.MaxMessageBytes, so this file
// pins the RELATIONSHIP (refuse iff above the protocol maximum) and never a
// particular number.

// TestValidateRefusesAMaxMessageBytesTheRelayCannotDeliver pins the boundary
// exactly: at or below the protocol maximum starts, above it does not.
func TestValidateRefusesAMaxMessageBytesTheRelayCannotDeliver(t *testing.T) {
	cases := []struct {
		name        string
		configured  int64
		wantRefusal bool
	}{
		{
			name:       "the protocol maximum itself is permitted",
			configured: protocol.MaxMessageBytes,
		},
		{
			name:       "one byte below the protocol maximum is permitted",
			configured: protocol.MaxMessageBytes - 1,
		},
		{
			name:       "a much lower maximum is permitted: stricter than its clients is safe",
			configured: protocol.MaxMessageBytes / 8,
		},
		{
			// Permitted as a VALUE only. An operator who sets the variable to 0 is
			// refused by Load(), which can tell an explicit zero from an unset
			// variable - see TestLoadRefusesAnExplicitlyZeroMaxMessageBytes.
			name: "zero is permitted: it is the zero value of a partially constructed Config, " +
				"which internal/server builds directly and the handler resolves to the protocol maximum",
			configured: 0,
		},
		{
			name:        "one byte above the protocol maximum is refused",
			configured:  protocol.MaxMessageBytes + 1,
			wantRefusal: true,
		},
		{
			// The shape of configuration the retired
			// TestMaximumSizeEnvelopeIsDeliverableAtRaisedMaxMessageBytes drove: a
			// maximum several times the protocol one (it used 2 MiB against a 256 KB
			// protocol maximum). Written as a multiple, never as that literal, so
			// this case keeps meaning "well above the ceiling" if the ceiling moves.
			name:        "a maximum several times the protocol one is refused",
			configured:  2 * protocol.MaxMessageBytes,
			wantRefusal: true,
		},
		{
			name:        "a negative maximum is refused: it would reject every legitimate envelope",
			configured:  -1,
			wantRefusal: true,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			err := Config{MaxMessageBytes: testCase.configured}.Validate()

			if !testCase.wantRefusal {
				if err != nil {
					t.Fatalf("Validate() with ECHOLET_MAX_MESSAGE_BYTES = %d returned %v, want nil; the protocol "+
						"maximum is %d and a deployment may configure any value up to it",
						testCase.configured, err, protocol.MaxMessageBytes)
				}
				return
			}

			if err == nil {
				t.Fatalf("Validate() with ECHOLET_MAX_MESSAGE_BYTES = %d returned nil, want a refusal; the protocol "+
					"maximum is %d, and a relay that starts above it accepts envelopes it can never hand back",
					testCase.configured, protocol.MaxMessageBytes)
			}
			if !strings.Contains(err.Error(), "ECHOLET_MAX_MESSAGE_BYTES") {
				t.Fatalf("refusal for %d does not name the variable an operator has to change: %q",
					testCase.configured, err.Error())
			}
		})
	}
}

// TestLoadRefusesAMaxMessageBytesAboveTheProtocolMaximum drives the real startup
// path an operator takes, so the refusal is pinned where it actually happens -
// Load(), the way the TLS-pair refusal is - and not only on Validate() in
// isolation.
func TestLoadRefusesAMaxMessageBytesAboveTheProtocolMaximum(t *testing.T) {
	clearTLSEnv(t)
	above := protocol.MaxMessageBytes + 1
	t.Setenv("ECHOLET_MAX_MESSAGE_BYTES", strconv.FormatInt(above, 10))

	_, err := Load()
	if err == nil {
		t.Fatalf("Load() returned nil for ECHOLET_MAX_MESSAGE_BYTES = %d, above the protocol maximum of %d; the "+
			"relay must refuse to start rather than accept messages no recipient can poll back (RI-09)",
			above, protocol.MaxMessageBytes)
	}
	for _, want := range []string{"ECHOLET_MAX_MESSAGE_BYTES", fmt.Sprintf("%d", protocol.MaxMessageBytes)} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("startup refusal does not tell the operator %q: %q", want, err.Error())
		}
	}
}

// TestLoadRefusesAnExplicitlyZeroMaxMessageBytes closes residual R-3's
// operator-facing half (flow 003, T22).
//
// Validate() permits a zero VALUE, because a zero-value Config means
// "unconfigured" and the handler resolves it to the protocol maximum (see
// api/handler/unconfigured_max_message_bytes_test.go). An operator who writes
// ECHOLET_MAX_MESSAGE_BYTES=0 is not unconfigured, though: they set the variable,
// and they meant something by it - most likely "no limit", the convention plenty
// of other software uses. Answering that with a silent 256 KB would be a second
// silent reinterpretation of their intent, and answering it the way the relay
// used to - come up healthy and refuse every envelope as PAYLOAD_TOO_LARGE - is
// the defect itself. So it is refused at the one moment somebody is watching, the
// same way the half-configured TLS pair and the above-ceiling maximum are.
//
// This distinction lives in Load() and not in Validate() because Load() is the
// only place that can make it: "the variable is unset" and "the variable is set
// to 0" are the same int64 by the time Validate() sees a Config.
func TestLoadRefusesAnExplicitlyZeroMaxMessageBytes(t *testing.T) {
	clearTLSEnv(t)
	t.Setenv("ECHOLET_MAX_MESSAGE_BYTES", "0")

	cfg, err := Load()
	if err == nil {
		t.Fatalf("Load() returned nil for an explicit ECHOLET_MAX_MESSAGE_BYTES=0 (MaxMessageBytes = %d); a relay "+
			"started that way answers PAYLOAD_TOO_LARGE to every legitimate envelope, so it must refuse to start "+
			"rather than come up healthy and accept nothing (residual R-3)", cfg.MaxMessageBytes)
	}
	if !strings.Contains(err.Error(), "ECHOLET_MAX_MESSAGE_BYTES") {
		t.Fatalf("startup refusal does not name the variable an operator has to change: %q", err.Error())
	}
	// The operator has to learn what to do instead, not merely that they were
	// wrong: the ceiling they may configure up to is the actionable half.
	if !strings.Contains(err.Error(), fmt.Sprintf("%d", protocol.MaxMessageBytes)) {
		t.Fatalf("startup refusal does not tell the operator the protocol maximum %d they may configure up to: %q",
			protocol.MaxMessageBytes, err.Error())
	}
}

// TestLoadAcceptsAnExplicitlySetMaxMessageBytesBelowTheProtocolMaximum keeps the
// refusal above from being over-broad. Configuring LESS is a deployment's
// business and must keep working: a relay stricter than its clients is merely
// stricter, and every bound scales down with it.
func TestLoadAcceptsAnExplicitlySetMaxMessageBytesBelowTheProtocolMaximum(t *testing.T) {
	clearTLSEnv(t)
	lower := protocol.MaxMessageBytes / 8
	t.Setenv("ECHOLET_MAX_MESSAGE_BYTES", strconv.FormatInt(lower, 10))

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() with ECHOLET_MAX_MESSAGE_BYTES = %d returned %v, want nil; a deployment may configure any "+
			"positive value up to the protocol maximum of %d", lower, err, protocol.MaxMessageBytes)
	}
	if cfg.MaxMessageBytes != lower {
		t.Fatalf("MaxMessageBytes = %d, want the configured %d", cfg.MaxMessageBytes, lower)
	}
}

// TestLoadTreatsAnEmptyMaxMessageBytesAsUnset pins the one place the refusal
// above depends on the env decoder's behaviour rather than on our own code.
//
// `ECHOLET_MAX_MESSAGE_BYTES=` with nothing after it is a shape that appears in
// real .env files, and os.LookupEnv reports it as SET. If the decoder produced a
// zero from it, the refusal above would turn a harmless empty line into a relay
// that will not start - on hosts that are live. It does not: an empty value falls
// back to the envDefault. Measured, then pinned here, because the refusal's
// safety rests on it.
func TestLoadTreatsAnEmptyMaxMessageBytesAsUnset(t *testing.T) {
	clearTLSEnv(t)
	t.Setenv("ECHOLET_MAX_MESSAGE_BYTES", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned %v for an empty ECHOLET_MAX_MESSAGE_BYTES, want nil; an empty line in a .env "+
			"file means \"I did not configure this\", and must not stop a running deployment from restarting", err)
	}
	if cfg.MaxMessageBytes != protocol.MaxMessageBytes {
		t.Fatalf("MaxMessageBytes = %d for an empty value, want the protocol maximum %d",
			cfg.MaxMessageBytes, protocol.MaxMessageBytes)
	}
}

// TestLoadDefaultsToTheProtocolMaximum pins the envDefault struct tag - which has
// to be a literal - against the constant it mirrors, so an unset variable and the
// protocol maximum can never drift apart.
func TestLoadDefaultsToTheProtocolMaximum(t *testing.T) {
	clearTLSEnv(t)
	// t.Setenv registers the restore; os.Unsetenv then removes the variable
	// outright, so the test observes the real "operator set nothing" case rather
	// than an empty string the env decoder may treat differently. Same shape as
	// clearTLSEnv in tls_config_test.go.
	t.Setenv("ECHOLET_MAX_MESSAGE_BYTES", "")
	if err := os.Unsetenv("ECHOLET_MAX_MESSAGE_BYTES"); err != nil {
		t.Fatalf("unset ECHOLET_MAX_MESSAGE_BYTES: %v", err)
	}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned %v, want nil", err)
	}
	if cfg.MaxMessageBytes != protocol.MaxMessageBytes {
		t.Fatalf("MaxMessageBytes default = %d, want the protocol maximum %d; the envDefault struct tag is a literal "+
			"copy of that constant and nothing but this test keeps the two in step",
			cfg.MaxMessageBytes, protocol.MaxMessageBytes)
	}
}
