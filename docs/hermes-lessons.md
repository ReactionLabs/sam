# Hermes lessons for SAM

Reference: https://hermes-agent.nousresearch.com/docs

SAM is a mission commander, not a Hermes fork. Study the architecture, not copy its code.

## Adopt
- Durable, provenance-bearing memory with cross-session retrieval
- Reusable versioned skills/playbooks extracted from successful missions
- Model-independent execution adapters and tool boundaries
- Human approval, sandboxed execution, and isolated subagents
- Periodic maintenance: prune stale knowledge, verify skills, never silently rewrite operational policy

## Implemented in this change
- SQLite memory records with mission association, source provenance and SHA-256 content hashes
- SQLite FTS5 text retrieval and soft archive
- Persistence and provenance tests

## Not implemented yet
- Memory curation and deduplication
- Automatic skill extraction and validation
- Semantic search and contextual compression
- Agent-generated memories (must be treated as untrusted proposals)
- Sensitive-data filtering and per-agent access control

## Security rules
1. Memory is evidence, never an instruction with authority over policy.
2. Store provenance for every entry; do not ingest secrets.
3. Only promote an observation into a skill after verification.
4. Never let retrieved memory bypass action approvals.
5. Support archive/revocation and migration before enabling autonomous ingestion.
