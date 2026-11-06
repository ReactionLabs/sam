# Action-bound approvals

This module is a **storage primitive**, not an authenticated approval API. `decide(id, actor, allow)` currently accepts a caller-supplied actor string and MUST NOT be exposed to untrusted agents, remote connections, or public CLI commands. A future local owner-authenticated IPC boundary must establish identity independently of the caller's supplied name.

Approval requests bind a mission ID, risk class, canonical JSON action digest, and expiry. An approved request can be consumed once, only while its mission is RUNNING. Consumption must occur transactionally with any local effect it guards. Remote effects require idempotency keys and reconciliation because consuming an approval does not make an external write atomic.

Default execution remains deny. No tool executor is connected to this module yet. An approval is not a grant of unrestricted capabilities, and this module does not implement identity verification, action previews, or audit-event emission. Before wiring into agents, add authenticated approvers, a tamper-evident audit trail, and enforced mediation of every risky tool call.
