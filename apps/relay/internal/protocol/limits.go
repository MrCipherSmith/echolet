// Package protocol carries the values Echolet fixes at the PROTOCOL level: the
// ones the relay and every client have to agree on in advance, because nothing
// on this wire negotiates them at runtime.
//
// The source of truth is the shared protocol package,
// packages/protocol/src/constants/limits.ts (LIMITS). This file mirrors it for
// the Go side; the two must be changed together, and a change to either is a
// protocol change rather than a deployment decision.
package protocol

// MaxMessageBytes is the largest ciphertext an envelope may carry, and the
// ceiling every deployment's ECHOLET_MAX_MESSAGE_BYTES is validated against
// (config.Validate). It mirrors LIMITS.MAX_MESSAGE_BYTES.
//
// It is a CEILING, not a fixed size: a deployment may configure less, because a
// relay that accepts less than a client is prepared to carry is merely stricter.
// A deployment may not configure MORE - the client sizes its own response bound
// from this same number and would refuse the poll response carrying such an
// envelope back, leaving it accepted, stored and undeliverable with nothing
// anywhere saying so (residual RI-09).
const MaxMessageBytes int64 = 262144 // 256 KB
