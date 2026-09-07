/**
 * The single definition of "loopback" this CLI has.
 *
 * Plain HTTP is admitted to loopback and to nothing else, and TWO components decide that: the
 * transport (`RelayClient`, which refuses a base URL it may not speak plaintext to) and the
 * configuration boundary (`parseClientConfig`, which refuses to write such a profile in the first
 * place). Until finding T10R3-F-003 they each carried their own rule and the two did not agree:
 * `parseClientConfig` required a dotted quad, while `RelayClient` tested the PREFIX `/^127\./`,
 * which is a test on the first four characters of a NAME and not on an address at all.
 * `127.evil.example` and `127.0.0.1.evil.example` are ordinary registrable domains an attacker can
 * own and point anywhere, and the prefix rule called them loopback - so the transport would have
 * carried every relay request to an attacker-chosen host in the clear. It was unreachable through
 * the CLI only because `commands/cli.ts` happens to run `parseClientConfig` first: a defence in
 * depth that works in one order only is not one.
 *
 * The rule therefore lives here, once, and both import it. It is deliberately the STRICTER of the
 * two originals - the direction of the old disagreement was the transport admitting plaintext to a
 * remote host, so the stricter rule is the safe one to converge on - and it is unchanged from what
 * `parseClientConfig` already enforced, so `127.0.0.1`, `127.9.9.9`, `localhost` and `[::1]`, which
 * every e2e suite in this repository depends on, keep working exactly as before.
 *
 * `hostname` is a WHATWG `URL.hostname`: already lowercased, already IPv4-normalised (`127.1`
 * arrives here as `127.0.0.1`), and an IPv6 literal arrives bracketed. A hostname that is not a
 * valid IPv4 address cannot reach this function as four dotted decimal components, because the URL
 * parser rejects such a host outright for a special scheme.
 */
export const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname);
