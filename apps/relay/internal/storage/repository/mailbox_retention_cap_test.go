package repository

import (
	"testing"
	"time"
)

// Coverage guard for round-2 review finding T38r2-TP-001 (minor).
//
// SetRetentionCap (mailbox_repo.go:42-47) is the only path by which the server's configured
// ECHOLET_MAILBOX_TTL_HOURS reaches the store (router.go:32), yet it had no test caller: making its
// body a no-op left `go test ./internal/...` fully green, and so did deleting its non-positive
// guard. The code is correct; what was missing is a test that fails when it is neutered.
//
// Two independent properties are pinned, one per line of the function:
//
//  1. a configured cap SHORTENS physical retention below the envelope's own declared lifetime;
//  2. a non-positive cap is IGNORED, so an unconfigured Config cannot silently reduce retention to
//     zero and make every accepted envelope immediately expired.
//
// Only deadlines in Unix seconds are printed; the ciphertext is synthetic padding.

func TestSetRetentionCapBoundsPhysicalRetention(t *testing.T) {
	hourMS := int64(time.Hour / time.Millisecond)

	t.Run("a configured cap shorter than the declared lifetime wins", func(t *testing.T) {
		store, repo := newMailboxRepositoryForTest(t)
		const configuredCap = 2 * time.Hour
		repo.SetRetentionCap(configuredCap)

		nowMS := time.Now().UnixMilli()
		envelope := newRetentionTestEnvelope(
			"mailbox-t38r2tp001-configured",
			"44444444-4444-4444-8444-444444444444",
			nowMS-1000,
			nowMS+24*hourMS,
		)
		if err := repo.SaveEnvelope(envelope); err != nil {
			t.Fatalf("SaveEnvelope() error = %v", err)
		}

		storedExpiry := storedEnvelopeExpirySeconds(t, store, envelope)
		wantExpiry := nowMS/1000 + int64(configuredCap/time.Second)
		declaredExpiry := envelope.ExpiresAtMs / 1000
		if storedExpiry == 0 {
			t.Fatalf("stored envelope has no physical expiry, want a deadline at %d", wantExpiry)
		}
		if diff := storedExpiry - wantExpiry; diff > mailboxRetentionToleranceSeconds || diff < -mailboxRetentionToleranceSeconds {
			t.Fatalf("stored retention deadline = %d, want the configured %s cap at %d (+/-%ds); the envelope's own declared expiry is %d: SetRetentionCap must actually apply the server-configured cap",
				storedExpiry, configuredCap, wantExpiry, mailboxRetentionToleranceSeconds, declaredExpiry)
		}
	})

	for _, nonPositive := range []time.Duration{0, -time.Hour} {
		t.Run("a non-positive cap keeps the default", func(t *testing.T) {
			store, repo := newMailboxRepositoryForTest(t)
			repo.SetRetentionCap(nonPositive)

			nowMS := time.Now().UnixMilli()
			envelope := newRetentionTestEnvelope(
				"mailbox-t38r2tp001-nonpositive",
				"55555555-5555-4555-8555-555555555555",
				nowMS-1000,
				nowMS+30*24*hourMS,
			)
			if err := repo.SaveEnvelope(envelope); err != nil {
				t.Fatalf("SaveEnvelope() error = %v", err)
			}

			storedExpiry := storedEnvelopeExpirySeconds(t, store, envelope)
			wantExpiry := nowMS/1000 + int64(DefaultMailboxRetentionCap/time.Second)
			if diff := storedExpiry - wantExpiry; diff > mailboxRetentionToleranceSeconds || diff < -mailboxRetentionToleranceSeconds {
				t.Fatalf("stored retention deadline after SetRetentionCap(%s) = %d, want the default cap at %d (+/-%ds): a non-positive configured value must be ignored, never applied as a zero-length retention",
					nonPositive, storedExpiry, wantExpiry, mailboxRetentionToleranceSeconds)
			}
		})
	}
}
