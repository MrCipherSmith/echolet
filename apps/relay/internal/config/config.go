package config

import (
	"errors"
	"fmt"

	"echolet/apps/relay/internal/protocol"

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
	// MaxMessageBytes is the largest ciphertext this deployment accepts. Its
	// default IS the protocol maximum (protocol.MaxMessageBytes, mirroring
	// LIMITS.MAX_MESSAGE_BYTES); the envDefault has to be a literal because it is
	// a struct tag, and the two are pinned together by Validate(). Lowering it is
	// a deployment's business; raising it past the protocol maximum is refused at
	// startup - see Validate() for why silence there is the worst outcome.
	MaxMessageBytes     int64 `env:"ECHOLET_MAX_MESSAGE_BYTES" envDefault:"262144"`
	MailboxTTLHours     int   `env:"ECHOLET_MAILBOX_TTL_HOURS" envDefault:"168"`
	ChallengeTTLSeconds int   `env:"ECHOLET_CHALLENGE_TTL_SECONDS" envDefault:"60"`
	MaxMailboxBatch     int   `env:"ECHOLET_MAX_MAILBOX_BATCH" envDefault:"100"`
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
//
// ECHOLET_MAX_MESSAGE_BYTES is refused on the same principle (residual RI-09).
// The maximum message size is a PROTOCOL constant, agreed in advance by both
// sides (protocol.MaxMessageBytes, mirroring LIMITS.MAX_MESSAGE_BYTES in
// packages/protocol) and never negotiated on the wire: the client sizes its own
// poll-response bound from it and the relay sizes its poll byte budget from it.
// A deployment may configure LESS - a relay that accepts less than a client can
// carry is merely stricter, and every bound here scales down with it. A
// deployment may not configure MORE: the relay would accept an envelope, store
// it, and answer every poll with a body above the bound the recipient enforces,
// so the recipient refuses the whole batch, acknowledges nothing and the mailbox
// is undeliverable - accepted, stored, and silent. One environment variable is
// enough to do that, and nothing at runtime would report it, so it is refused at
// the one moment somebody is watching.
func (c Config) Validate() error {
	if (c.TLSCertFile == "") != (c.TLSKeyFile == "") {
		return errors.New("ECHOLET_TLS_CERT_FILE and ECHOLET_TLS_KEY_FILE must be set together: " +
			"set both to serve HTTPS, or neither to serve plain HTTP. Refusing to start rather than " +
			"silently serving plain HTTP with TLS half configured")
	}
	if c.TLSReloadIntervalSeconds < 0 {
		return fmt.Errorf("ECHOLET_TLS_RELOAD_INTERVAL_SECONDS must not be negative, got %d", c.TLSReloadIntervalSeconds)
	}
	if c.MaxMessageBytes < 0 {
		// Not merely useless: this value is the ciphertext bound the send route
		// validates against, so a negative one makes the relay come up healthy and
		// refuse every legitimate envelope as PAYLOAD_TOO_LARGE. Zero is left
		// alone deliberately - it is the zero value of a partially constructed
		// Config, which the server package builds directly and which the handler
		// reads as "unconfigured, use the protocol maximum"; Load() can never
		// produce it, because the field carries an envDefault.
		return fmt.Errorf("ECHOLET_MAX_MESSAGE_BYTES must not be negative, got %d", c.MaxMessageBytes)
	}
	if c.MaxMessageBytes > protocol.MaxMessageBytes {
		return fmt.Errorf("ECHOLET_MAX_MESSAGE_BYTES is %d, above the protocol maximum of %d: a client sizes its "+
			"poll-response bound from the same protocol maximum, so an envelope larger than it would be accepted, "+
			"stored and then refused in full by every recipient, leaving the mailbox undeliverable. Configure %d or "+
			"less. Refusing to start rather than silently accepting messages that can never be delivered",
			c.MaxMessageBytes, protocol.MaxMessageBytes, protocol.MaxMessageBytes)
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
