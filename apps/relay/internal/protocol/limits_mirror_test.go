package protocol

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// Flow 003 T27 - V-006, the Go half of a relationship that was guarded in one
// direction only.
//
// MaxMessageBytes is documented as a mirror of LIMITS.MAX_MESSAGE_BYTES in
// packages/protocol/src/constants/limits.ts, and its own comment says "the two
// must be changed together". Until this file nothing enforced that. The Go
// direction was caught indirectly - doubling MaxMessageBytes fails three named
// assertions in internal/api/handler and internal/config - but the TypeScript
// direction was caught by nothing at all: flow 003 T25 measured
// MAX_MESSAGE_BYTES: 131072 leaving 21 files and 83 tests green in apps/cli
// while this constant stayed at 262144. A relay that accepts more than the
// client will read back leaves envelopes accepted, stored and unacknowledged
// with nothing anywhere saying so, which is residual RI-09 exactly.
//
// This test carries NO number of its own. It reads the TypeScript source and
// compares it with the Go constant, so it cannot be satisfied by a third
// hand-written copy of the value - the point of the closure in 5235a6d was that
// four copies became two, and a test holding a fifth would pin nothing. The
// companion assertion on the TypeScript side is in
// apps/cli/src/transport/relayClient.protocolMirror.test.ts, so a divergence is
// red whichever suite is run.

// typeScriptLimitsPath is relative to this package's directory, which is the
// working directory `go test` gives a test binary:
// apps/relay/internal/protocol -> internal -> relay -> apps -> the repository.
const typeScriptLimitsPath = "../../../../packages/protocol/src/constants/limits.ts"

// maxMessageBytesInTypeScript matches the LIMITS entry and nothing else. The
// underscore is allowed because TypeScript permits numeric separators; the
// trailing comment on the line is not captured.
var maxMessageBytesInTypeScript = regexp.MustCompile(`\bMAX_MESSAGE_BYTES\s*:\s*([0-9_]+)`)

func TestMaxMessageBytesMirrorsTheTypeScriptProtocolConstant(t *testing.T) {
	path := filepath.FromSlash(typeScriptLimitsPath)

	source, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read the protocol source of truth at %s: %v. MaxMessageBytes is documented as a "+
			"mirror of LIMITS.MAX_MESSAGE_BYTES; if that file moved, this assertion has to move with it "+
			"rather than be dropped, or the two constants are once again free to diverge", path, err)
	}

	match := maxMessageBytesInTypeScript.FindSubmatch(source)
	if match == nil {
		t.Fatalf("%s declares no `MAX_MESSAGE_BYTES: <number>` entry. A mirror this test cannot read is a "+
			"mirror it is not checking", path)
	}

	typescript, err := strconv.ParseInt(strings.ReplaceAll(string(match[1]), "_", ""), 10, 64)
	if err != nil {
		t.Fatalf("LIMITS.MAX_MESSAGE_BYTES in %s is not an integer literal this test can compare: %v", path, err)
	}

	// The guard against a vacuous pass: a regex that matched a zero, or a
	// constant someone set to zero, must not read as agreement.
	if typescript <= 0 || MaxMessageBytes <= 0 {
		t.Fatalf("a message-size ceiling of zero is not a ceiling: TypeScript %d, Go %d", typescript, MaxMessageBytes)
	}

	// The pin, in both directions. Lowering EITHER constant alone leaves the
	// relay accepting envelopes the client refuses to read back; raising either
	// alone leaves a deployment configurable for a size the other end will not
	// carry. Neither is a deployment decision.
	if MaxMessageBytes != typescript {
		t.Fatalf("protocol.MaxMessageBytes = %d but LIMITS.MAX_MESSAGE_BYTES = %d in %s. These two are one "+
			"protocol value with two representations and must be changed together: the relay validates every "+
			"deployment's ECHOLET_MAX_MESSAGE_BYTES against the Go constant, while the client sizes its send "+
			"bound and its poll-response bound from the TypeScript one, so a divergence means envelopes the "+
			"relay accepts and stores and the recipient will never acknowledge (residual RI-09)",
			MaxMessageBytes, typescript, path)
	}
}
