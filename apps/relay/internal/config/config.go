package config

import (
	"errors"
	"fmt"

	"github.com/caarlos0/env/v11"
)

type Config struct {
	// HTTPAddr is the one listen address, for both the plain and the TLS
	// listener. There is deliberately no second ECHOLET_HTTPS_ADDR: the relay
	// serves exactly one scheme at a time, decided by whether the certificate
	// pair below is configured, so two addresses could only ever disagree.
	HTTPAddr string `env:"ECHOLET_HTTP_ADDR" envDefault:":8081"`
	// TLSCertFile and TLSKeyFile are a PEM certificate chain and its private key
	// on disk. Set BOTH and the relay serves HTTPS on HTTPAddr; set NEITHER and
	// it serves plain HTTP, which is all a loopback relay needs and all the local
	// test suites use. Setting exactly one is refused by Validate() - see the
	// comment there for why a silent fallback would be the worst outcome.
	//
	// On the deployment target these are the files `tailscale cert` writes and
	// renews for a `<host>.<tailnet>.ts.net` name. The relay reads them; it never
	// requests, renews or generates a certificate, and it never logs their
	// contents.
	TLSCertFile string `env:"ECHOLET_TLS_CERT_FILE"`
	TLSKeyFile  string `env:"ECHOLET_TLS_KEY_FILE"`
	// TLSReloadIntervalSeconds bounds how often a TLS handshake may re-read the
	// pair from disk to notice a renewal. 0 means check on every handshake, which
	// is what the tests use; the default trades a little I/O for picking up a
	// `tailscale cert` renewal without a restart.
	TLSReloadIntervalSeconds int    `env:"ECHOLET_TLS_RELOAD_INTERVAL_SECONDS" envDefault:"60"`
	DataDir                  string `env:"ECHOLET_DATA_DIR" envDefault:"./.data/relay"`
	LogLevel                 string `env:"ECHOLET_LOG_LEVEL" envDefault:"info"`
	NodeCallsign             string `env:"ECHOLET_NODE_CALLSIGN" envDefault:"RPT-LOCAL-DEV"`
	MaxStorageBytes          int64  `env:"ECHOLET_MAX_STORAGE_BYTES" envDefault:"2147483648"`
	MaxMessageBytes          int64  `env:"ECHOLET_MAX_MESSAGE_BYTES" envDefault:"262144"`
	MailboxTTLHours          int    `env:"ECHOLET_MAILBOX_TTL_HOURS" envDefault:"168"`
	ChallengeTTLSeconds      int    `env:"ECHOLET_CHALLENGE_TTL_SECONDS" envDefault:"60"`
	MaxMailboxBatch          int    `env:"ECHOLET_MAX_MAILBOX_BATCH" envDefault:"100"`
	// MaxUnackedEnvelopesPerSender bounds how many unacknowledged envelopes one
	// sender identity may hold in one recipient mailbox. The default (16) is
	// chosen against the drain-walk capacity MaxMailboxBatch and MaxMessageBytes
	// produce - 48 maximum-size envelopes across the client's 16-page walk at the
	// defaults above - so raising either of those without revisiting this one
	// widens the walk the quota was sized against. See
	// api/handler/mailbox_handler.go (defaultSenderUnackedQuota).
	MaxUnackedEnvelopesPerSender int `env:"ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER" envDefault:"16"`
	RateLimitPerMinute           int `env:"ECHOLET_RATE_LIMIT_PER_MINUTE" envDefault:"120"`
	CleanupIntervalSec           int `env:"ECHOLET_CLEANUP_INTERVAL_SECONDS" envDefault:"60"`
}

// TLSEnabled reports whether the relay should serve HTTPS. It is true only when
// both halves of the certificate pair are configured; Validate() guarantees that
// a half-configured pair never reaches this point.
func (c Config) TLSEnabled() bool {
	return c.TLSCertFile != "" && c.TLSKeyFile != ""
}

// Validate refuses a configuration the relay must not start with.
//
// The half-configured certificate pair is the important one. The CLI refuses a
// non-loopback relay URL that is not HTTPS, so an operator who sets one of the
// two variables believes they have enabled TLS. Serving plain HTTP anyway would
// be a silent downgrade: the relay would come up, answer /health, and carry
// every envelope in the clear on a network the operator thought was protected.
// Refusing at startup makes that mistake loud and unmissable instead.
func (c Config) Validate() error {
	if (c.TLSCertFile == "") != (c.TLSKeyFile == "") {
		return errors.New("ECHOLET_TLS_CERT_FILE and ECHOLET_TLS_KEY_FILE must be set together: " +
			"set both to serve HTTPS, or neither to serve plain HTTP. Refusing to start rather than " +
			"silently serving plain HTTP with TLS half configured")
	}
	if c.TLSReloadIntervalSeconds < 0 {
		return fmt.Errorf("ECHOLET_TLS_RELOAD_INTERVAL_SECONDS must not be negative, got %d", c.TLSReloadIntervalSeconds)
	}
	return nil
}

func Load() (Config, error) {
	cfg := Config{}
	if err := env.Parse(&cfg); err != nil {
		return cfg, err
	}
	if err := cfg.Validate(); err != nil {
		return cfg, err
	}
	return cfg, nil
}
