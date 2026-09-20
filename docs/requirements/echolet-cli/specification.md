# Echolet CLI Specification
Version: 1.0.0

## Module Identity
- **Name**: `@echolet/cli` (or `echolet` if available)
- **Primary Entrypoint**: `apps/cli/dist/cli.js`

## Storage Structure
All state is stored securely in the user's home directory:
```text
~/.echolet/
├── config.json                     # Global config
├── run/                            # PID files (station.pid, repeater.pid)
├── logs/                           # Logs (station.log, repeater.log)
├── profiles/                       # Cryptographic profiles
│   ├── <Callsign>/
│   │   ├── client.sqlite           # Encrypted DB
│   │   ├── store.key               # 32-byte master key (0600)
│   │   ├── identity.card.json      # Public identity
│   │   └── config.json             # Station config
└── repeater/                       # Local repeater
    ├── config.env                  # Env vars
    └── data/                       # BadgerDB data
```
Directory permissions must be `0700` (`drwx------`).

## Manifest/Config Shape
The `package.json` for the CLI must include:
```json
{
  "bin": { "echolet": "./dist/cli.js" },
  "files": [ "dist", "web-dist" ],
  "scripts": {
    "prepublishOnly": "node ../web/build.mjs && cp -r ../web/dist ./web-dist && node build.mjs && pnpm test"
  }
}
```

## CLI Surface
A **Layered Dispatcher** intercepts operator commands before hitting the strict `parseArgs` parser.

- `echolet station [setup|start|stop|status|open]`
- `echolet repeater [setup|start|stop|status|logs]`
- `echolet profile [list|switch|export|delete]`
- `echolet contact [list|add|verify]`
- `echolet radio` (TUI interface)
- `echolet doctor` (Diagnostics)

Cross-platform process stopping:
- Unix: `process.kill(pid, "SIGTERM")`
- Windows: `execSync('taskkill /pid ' + pid + ' /T /F')`

## Data Contracts
- `cliBridge.ts` expects an absolute path to the CLI via `process.env.ECHOLET_CLI_PATH`, falling back to local/relative paths.

## Integration Points
- **Web Client**: CLI spawns the React frontend server using `web-dist/`.
- **Relay (Docker)**: `repeater setup` generates a standard Docker run command binding to `127.0.0.1:8081` with capabilities dropped.
- **Tailscale**: `repeater setup` configures local Tailscale TLS certs.

## Acceptance Criteria
- [ ] `npm install -g echolet` successfully links the binary.
- [ ] `echolet station setup` generates keys securely in `~/.echolet/`.
- [ ] Protocol commands like `echolet init` continue to function without error.
- [ ] `echolet station start` launches the web UI and it can find `cliBridge.ts`.
- [ ] `pnpm test` in `apps/cli` passes all 79 suites.
