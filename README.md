# S.A.M. | Secret Agent Man

CLI-first agent commander and durable mission runtime.

> Status: early implementation, not production ready.

## Quick start

```bash
npm install
npm run build
node apps/cli/dist/index.js init
node apps/cli/dist/index.js mission create "Audit this repository"
node apps/cli/dist/index.js mission list
```

Initial milestone: deterministic local mission kernel, SQLite persistence, and CLI. Model adapters, MCP, daemon, approvals, and operative execution will follow in separate milestones.
