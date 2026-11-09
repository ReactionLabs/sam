# MCP Connectors V1 (draft PR #61)

SAM is provider-independent. Second Shift is the first read-only test target, not a special case in the core.

## Setup on Windows

From the SAM checkout on the PR branch:

```powershell
git fetch origin
git switch feat/sam-mcp-connectors-first-20261108
npm install
npm run build
npm test
$env:SAM_MCP_TOKEN_SECOND_SHIFT = Read-Host "Second Shift test key"
node dist/cli.js dashboard
```

The environment variable must exist in the same PowerShell session that starts the dashboard. Do **not** paste the key into SAM chat, a browser connector form, GitHub, logs or a screenshot. A read-only, tenant-scoped test key is strongly recommended.

In Mission Control, click **Connectors**, enter the name `Second Shift`, endpoint `https://mcp.secondshiftos.com/mcp/v1` and token variable `SAM_MCP_TOKEN_SECOND_SHIFT`. Click **Connectors** again and cancel the new-connector prompt to manage saved connections. Choose `test` to initialize and discover tools. Choose `read` to call `whoami`, `pipeline_summary` and `list_leads` (maximum requested 10). The MCP server may use different tool names or endpoint versions; a failed live test needs inspection, not a claim of success.

## Security boundary

- Local dashboard token and loopback restrictions are inherited from Mission Control.
- Connector registry stores only a token *environment variable name*, never the secret value.
- HTTPS host must be explicitly allowed by `SAM_MCP_ALLOWED_HOSTS` (comma-separated exact hostnames; default `mcp.secondshiftos.com`). Redirects are rejected.
- Calls are limited to `whoami`, `list_leads`, `get_lead`, `pipeline_summary`, `analytics_summary` by the server-side dispatcher. The V1 UI invokes only the first three listed in its smoke path, plus `pipeline_summary`.
- Tool discovery is not permission to execute arbitrary tools. No model-directed connector calls, lead writes, email sends, or billing actions.
- Each call initializes MCP, sends the initialized notification and carries the session ID if supplied by the server.
- This is not yet a hardened multi-tenant connector vault. Do not expose the dashboard outside localhost or use fleet-wide admin keys.

## Definition of done

1. TypeScript build and tests pass on Windows and CI.
2. An authorized read-only key completes a live `whoami` and lead read.
3. Invalid key fails without revealing the token.
4. Write tool is rejected locally without network invocation.
5. Follow-up: proper connector settings page, credential vault, per-box/agent grants, live chat tool dispatch, and better response display.

**Verification:** The mocked handshake test is automated. A real Second Shift MCP connection has not yet been verified by the PR author.
