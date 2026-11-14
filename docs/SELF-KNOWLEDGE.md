# Self-knowledge: Mita's operating lessons, implemented in SAM

Program H (2026-11-14, Dip: "Learn what u can from yourself and
implement"). The lessons below were learned the hard way in
Mita's own harness, mostly on 2026-11-13, when her standing
memory file (MEMORY.md) was found to have regrown to 204,952
bytes, about 28,785 words carried into every turn, in eight
days. Dip's ruling that day: "We need to learn from this for
sam", "Because memory is the biggest deal." The six memory-layer
design requirements were filed in the fleet ROADMAP with no
build attached; this document is the build record: for each
requirement, what SAM already did, what was missing, and the
mechanism that now embodies it. Where a requirement does not
map cleanly onto SAM's architecture, that is said plainly and
the closest honest mechanism is what shipped.

## The audit (state before this build)

| # | Filed requirement | State before | Evidence |
|---|---|---|---|
| 1 | Hot memory is an index under a hard ~3,000-word budget, enforced on write | PARTIAL | Every injected tier was capped (law 4,000 chars, recall 1,800, summary 3,600, files 16,000/file) and the context audit measured the fixed load against 32,000 chars, but MemoryStore.add accepted a single record up to 100,000 chars (~25k words). No named hot budget existed. |
| 2 | Superseded state replaced in place; history in cold storage | MOSTLY TRUE | Law upserts by content hash and revoke supersedes in place; episodes keep exactly one live record per profile per day (prior archived in the same write); memory-fact supersession is owner-gated by design (note, proposal, approval, old archived). No build needed. |
| 3 | Completed episodes move out of hot memory to cold searchable storage, retrieval on demand | TRUE | Episodes live in the FTS5 memory store, injected only as at most 2 clipped lines through recall; full records on demand via search/list. Evidence pruned to 31 days per profile. No build needed. |
| 4 | Fences first, verbatim through summarization, post-compaction diff + identifier check | PARTIAL | Law is structurally verbatim (separate store, never summarized, injected from the store each turn), but nothing ever VERIFIED that: no diff, no identifier check, no failure line existed. An unmeasured invariant is a hope. |
| 5 | Injected-context size per turn is a first-class metric next to cost per task | PARTIAL | usage.jsonl counted provider tokens after the fact; the context audit measured the fixed system load on demand. The actual per-turn injected context (law + recall + standing + summary + history) was never measured or ledgered. |
| 6 | Post-compaction acceptance: still answer what waits on Dip, what it can act on, where the proof lives | MISSING | The eval battery (24 tasks) had no compaction-acceptance task. |
| A | (Keystone, not in the six) an owner's do-not-store instruction binds automatic capture | MISSING, live defect | No suppression concept anywhere. Episode flush and compaction flush wrote owner words verbatim with no check. On 2026-11-14 SAM itself found the test secret phrase, which Dip had told it to keep out of memory, sitting in an episode observation record, and answered from it with citations. |

Record-honesty companion set (inventory-first completeness,
fail-closed reads, named failure lines, outside-witness
verification): mostly landed by the hourly build loop before
this program (fail-closed reads in usage/activity/recall, one
named failure line per store, self-work classification per
kind). One evidenced gap was found and closed here: on the
episode WRITE path, a corrupt evidence row parsed silently to
empty and was overwritten by the next merge, the day's earlier
evidence gone with no line anywhere. It now ledgers one
`episodes-failed` line before the rebuild.

## The mechanisms

### A. The capture guard (`src/capture-guard.ts`) - the keystone

A standing do-not-store instruction is now a governed record,
not a sentence in a chat. A suppression (per profile: a needle,
provenance, active/revoked status) lives in preferences.db,
beside the law store it resembles. It is never injected into a
prompt and never returned by recall; activity lines carry only
its id and a sha256 prefix of the needle, never the words.

- Creation, deterministic (the extractPreferences discipline,
  the owner's own words, no model call): narrow forms - "keep X
  out of memory", "do not / don't / never store|remember|record
  X", "do not keep X in memory" - plus the incident's own shape:
  a bare "keep it out of memory" in the same message as a named
  secret ("the secret phrase is X") binds X. Recorded at both
  existing capture seams (the live turn in agent-turn.ts, the
  heartbeat scan) and by the operator CLI (`sam memory
  suppress`). Revocation is the owner's word via the CLI, a
  status flip, never a delete.
- Enforcement at write time, in depth:
  1. The episode flush filters suppressed messages out of the
     day's evidence AND summary, and the evidence row is saved
     filtered, so excerpts stored by an earlier unguarded tick
     are scrubbed on the next consolidation. If the whole day
     is suppressed, the stale derived record for that date is
     archived (the lifecycle already archives-and-replaces
     derived records every tick), never deleted.
  2. The compaction flush drops suppressed messages from its
     digest before writing.
  3. The preference-extraction seams drop suppressed finds.
  4. `MemoryStore.add` itself refuses any record matching an
     active suppression for its scope (core, that profile, or
     any profile for shared link scopes) by throwing
     `MemorySuppressedError`. Automatic paths catch it, ledger
     ONE `memory-suppressed` line, and degrade per their
     standing contracts; an explicit door (CLI add, a saved
     note, an approved action) surfaces the refusal loudly -
     the owner revokes the suppression first if the save is
     truly intended.
- A new suppression also ledgers how many live records already
  match, so the pre-existing backlog is a number on the owner's
  purge list, not a surprise. Nothing already stored is
  auto-purged: deletion of stored memory is the owner's tap.

Honest limits: suppression binds the memory store and its
derived evidence cache, not the chat record itself (the
owner's words in his own chats are his history) and not the
in-prompt compaction summary (the chat's own context). A bare
"keep it out of memory" with no named object anywhere in the
message is not deterministically extractable; the CLI door
covers that case. Tests prove a flush cycle cannot resurrect a
suppressed item across repeated consolidations
(`src/capture-guard.test.ts`).

### B. The hot-memory budget (`src/memory.ts`)

`MEMORY_RECORD_MAX_WORDS = 3000`, enforced in `add()`: a single
record over the budget is refused with a named error ("Memory
is an index, not an archive - store the full text as a file and
note the pointer instead"). The 100k-char ceiling stays as an
outer backstop. Why per-write is the honest mapping: SAM's hot
memory is not one injected file (the shape that bloated on
Mita's side); injection is tiered and already capped per tier.
The hole was the write side: nothing stopped one capture from
adding an archive-sized record to the store every tier draws
from. A new anchored context-audit check, `hot-memory-budget`,
proves the refusal with the real store on every audit run.

### C. Fence integrity (`src/fence-integrity.ts`)

Every compaction fold now runs Mita's trim-pass ritual as a
mechanism: snapshot the profile's standing law before the fold
(id + statement, digested), verify after the save -
byte-for-byte per record, plus every identifier extracted from
the before text (UUIDs, emails, URLs, phone-shaped digit runs,
letter+digit codes like 47-ALPHA) still present after. A
failure ledgers ONE `fence-integrity-failed` line naming the
changed records and lost identifiers, and the fold's compacted
context is refused (the caller fails open to the raw tail, its
standing contract). The reader is injectable so the check is
proven able to say no: the tests tamper with the after-read
and require the refusal.

### D. Context as a metric (`src/context-meter.ts`)

Every assembled chat turn records one line in
`.sam/context.jsonl`: system chars, and the memory-derived
tiers broken out (law, recall, standing files, compaction
summary, kept history), total chars and total words, by actor
and route. `sam usage context` reads today and all-time
summaries beside the token spend. The discipline is the usage
ledger's own: writes fail soft with ONE `context-failed` line
and never break a turn; reads fail closed (one line, then
rethrow), because a summary folded from an unreadable ledger
would report zero context as truth.

### E. Post-compaction acceptance (eval battery)

New battery task `compaction-acceptance` (battery now 25
tasks): in scratch state, seed law carrying an identifier, one
pending gate proposal (what waits on the owner), one open loop
(what SAM can act on), and one completed note whose
`note-saved` activity line carries its record id (where the
proof lives). Force a real compaction fold, then answer all
three questions from the real surfaces - pending proposals
list, open loops list, activity line + record read-back - plus
recall still surfacing the stored note, and the fence check
verifying law byte-identical across the fold.

## The five lessons, and where each one lives now

1. **Measure before you feel.** Mita's bloat was felt for weeks
   before it was measured at 28,785 words. SAM now meters
   every turn's injected context (D) and caps every memory
   write (B); the context audit carries the budget as an
   anchored check.
2. **An agent cannot grade its own homework from inside.**
   Mita's self-diagnosis of a Telegram defect was confidently
   wrong until an outside read settled it. SAM's fence check
   (C) verifies law from the store, not from the summarizer's
   account of it, and its tamper control proves the instrument
   can fail. The acceptance task (E) answers from surfaces,
   not from the model's memory of having done the work.
3. **"Complete" needs an enumerated inventory.** The ledger
   family was declared finished repeatedly before more seams
   surfaced. This program started from an audit table (above)
   with code evidence per requirement, and the record-honesty
   sweep it included found one more silent-loss seam (the
   episode evidence parse) that a feeling of completeness
   would have missed.
4. **Failure needs a voice.** Degraded states are product
   surfaces (the rate-limit grace message is the standing
   example). Every new mechanism here ledgers ONE named line
   in plain language - `memory-suppressed`,
   `memory-suppression`, `fence-integrity-failed`,
   `context-failed`, `episodes-failed` - and the three failure
   kinds join self-work classification, so the daily loop can
   queue a repair from a recorded spec. The guard's own lines
   deliberately do NOT classify: a suppression holding is the
   system working.
5. **One keystone beats broad progress.** The Codex sign-in
   unblocked more than any ten small fixes. Here the keystone
   was A: the guard. Built first, at the store itself, so every
   present and future capture path inherits it; B through E
   are smaller because A is load-bearing.
