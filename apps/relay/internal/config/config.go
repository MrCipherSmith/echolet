package config

import (
	"github.com/caarlos0/env/v11"
)

type Config struct {
	HTTPAddr            string `env:"ECHOLET_HTTP_ADDR" envDefault:":8081"`
	DataDir             string `env:"ECHOLET_DATA_DIR" envDefault:"./.data/relay"`
	LogLevel            string `env:"ECHOLET_LOG_LEVEL" envDefault:"info"`
	NodeCallsign        string `env:"ECHOLET_NODE_CALLSIGN" envDefault:"RPT-LOCAL-DEV"`
	MaxStorageBytes     int64  `env:"ECHOLET_MAX_STORAGE_BYTES" envDefault:"2147483648"`
	MaxMessageBytes     int64  `env:"ECHOLET_MAX_MESSAGE_BYTES" envDefault:"262144"`
	MailboxTTLHours     int    `env:"ECHOLET_MAILBOX_TTL_HOURS" envDefault:"168"`
	ChallengeTTLSeconds int    `env:"ECHOLET_CHALLENGE_TTL_SECONDS" envDefault:"60"`
	MaxMailboxBatch     int    `env:"ECHOLET_MAX_MAILBOX_BATCH" envDefault:"100"`
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

func Load() (Config, error) {
	cfg := Config{}
	if err := env.Parse(&cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}
