# Context

## Requirements & Specs
- [Echolet CLI Package Docs](../../../docs/requirements/echolet-cli/README.md)
- [PRD](../../../docs/requirements/echolet-cli/prd.md)
- [Specification](../../../docs/requirements/echolet-cli/specification.md)
- [Deployment Guide](../../../docs/REPEATER_DEPLOYMENT_RU.md)

## Key Source Files
- \`apps/cli/src/commands/cli.ts\` - Main CLI entrypoint and argument parser.
- \`apps/web/src/server/cliBridge.ts\` - Web bridge executing CLI commands.
- \`apps/cli/package.json\` - CLI package manifest for NPM publishing.
- \`apps/relay/Dockerfile\` - Dockerized relay container definition.
