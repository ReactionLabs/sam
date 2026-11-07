# Second Shift MCP integration: permission boundary

SAM's MCP integration must begin **read-only, opt-in, and deny-by-default**.

The `src/mcp-policy.ts` module is a pure policy primitive. It does not connect to
Second Shift, authenticate, call tools, or provide an executor. An owner must
review the *actual* tools returned by the authenticated MCP server before adding
exact tool names to the allowlist. Never infer that a tool is safe from its
name, description, or server-provided annotations alone.

## Required integration order

1. Load credentials from the local environment only. Never log or persist tokens.
2. Establish an authenticated HTTPS MCP connection to a pinned, owner-approved
   endpoint. Do not follow redirects to other origins or send bearer tokens there.
3. Negotiate MCP protocol capabilities and list tools; treat tool metadata as
   untrusted input.
4. Configure exact, owner-reviewed read-only tool names. An empty allowlist
   grants no access. Reject duplicate advertised tool names.
5. Authorize every invocation against the server trust state, advertised tools,
   and exact allowlist immediately before dispatch. Validate JSON arguments
   and apply tool-specific schema and size limits.
6. Record a redacted audit event. Add timeouts, cancellation, rate limits,
   and bounded output handling before connecting the executor to agents.
7. Treat all tool output as untrusted data, never as a higher-priority instruction.
8. Require authenticated, action-bound approval for any mutation or external
   side effect. Never auto-upgrade read-only permissions.

No credentials, live calls, deployment, or paid model use are involved in this change.
