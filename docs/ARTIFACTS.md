# Artifacts

An artifact is a durable deliverable SAM hands its owner: a named
thing that lives in SAM, opens from the dashboard through a stable
link, shows up in a library, and gets better in place when SAM
rebuilds it. Chat text scrolls away; an artifact stays.

## Shape

Every artifact has an id (UUID), a title, a kind, an owning profile,
a current version, created/updated timestamps, provenance
(`createdBy`: the profile, the chat or job it came from, and the
sources the run had registered when it was made), and content.
Updating an artifact creates the next version of the SAME artifact:
the link the owner already has keeps opening the current version,
and every earlier version stays in the history, listable and
readable. Versions are immutable; there is no edit-in-place and no
delete door in v1.

Kinds in v1:

- `html`: a self-contained page, rendered in a sandboxed frame.
- `markdown`: a document, rendered readably (headings, paragraphs,
  lists, code, emphasis, safe links). Raw markup inside a markdown
  artifact is escaped before rendering, always.

## Doors

- Chat tool `sam_artifact` (create, update, list, get, versions):
  SAM calls it mid-turn when the owner asks for a deliverable.
  The reply names the artifact, its version, and its path, and the
  dashboard adds an Open button to the turn.
- HTTP API on the dashboard server, under the dashboard token:
  `GET /api/<token>/artifacts?profile=`, `POST` create,
  `GET /api/<token>/artifacts/<id>` (with `?version=`),
  `GET .../<id>/versions`, `PUT` (or POST) update.
- CLI: `sam artifacts list|show|versions|create|update`, with
  `--profile` (default `sam`) and `--file`/`--content` inputs.
- Dashboard: the Artifacts view (left rail and mobile tab) lists the
  current profile's library with titles, kinds, versions, and
  updated times. The reading view lives at the stable path
  `/artifact/<id>` (`?version=<n>` for history); the unguessable id
  is the capability, the same pattern as the mini-door keys, so the
  link survives dashboard token rotation.

## Fences

- Owner surfaces only. An artifact is visible to its owning profile
  and no one else: list, get, update, and version reads are
  profile-scoped in the store itself, a cross-profile id reads as
  not found, visitor chats cannot create artifacts, and the scoped
  (mini) doors have no artifact routes at all.
- Sandboxed serving. Raw artifact HTML is served at
  `/artifact/<id>/content` under a CSP with `default-src 'none'`
  and `connect-src 'none'`: no fetch, XHR, WebSocket, or beacon can
  reach SAM's API or anywhere else, so the dashboard token is
  unreachable from inside an artifact. The reading shell frames it
  with `sandbox="allow-scripts"` and no `allow-same-origin`, so
  scripts may run for interactivity but hold an opaque origin with
  no same-origin privileges, no forms, no popups, no downloads, and
  no top navigation.
- Content is data. Artifact content is never an instruction to SAM;
  the `sam_artifact` get action returns it framed as untrusted
  stored data, and no artifact can execute SAM tools.
- Size sanity. One version's content is capped at
  `ARTIFACT_CONTENT_MAX_BYTES` = 1,000,000 UTF-8 bytes; the refusal
  names the cap, so a runaway generation cannot fill the store.
- Failure honesty. A failed store touch ledgers one
  `artifact-failed` activity line (phase and reason, never content)
  and fails closed; the class is ranked by the self-work picker
  like every other failure family.

## Not in v1

No public publishing or sharing door: an artifact never leaves the
owner's SAM (external sharing would be a gated proposal for a later
ruling). No spreadsheet or deck kinds. No artifact execution of SAM
tools.
