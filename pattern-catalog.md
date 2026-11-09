# Pattern Catalog

Fleet anti-pattern catalog, seeded 2026-11-09 from the Netflix performance-agent writeup (ByteByteGo, Nov 2026) and our own incident record. Format follows their model: plain Markdown in git, human-reviewable, entries written so an agent can inject them into a review prompt. Local incidents are marked LOCAL with the date; patterns imported from the Netflix piece are marked IMPORTED and are watch-items, not observed fleet defects.

How it is used:
- Fresh-context reviewers (SAM's goldfish verifier, fleet review passes) check diffs against this catalog before calling work done.
- The Trust Sweep pattern: when a new defect class is found in production, it gets an entry here the same day, so the next PR is checked for it before merge instead of after landing (shift left).
- Verification of any fix is by hard measurement (deployment read back by ID, live probe timings, test counts), never by a model's opinion of its own change.

## LOCAL-1: Bundle exclusion drops a lazily required library (2026-11-09)
vercel.json excludeFiles on api/** dropped lib/review-engine.js (and siblings) from every function bundle. A lazy require inside permission derivation crashed; the crash read fail-closed as "permission not held," and every OAuth grant carrying reviews.read was refused. Three ChatGPT pair attempts died on this before the root cause was found.
Check: any new excludeFiles rule or new lazy require must be cross-checked against each other. A fail-closed read must never be indistinguishable from a missing file.

## LOCAL-2: Resolver recognizes only one credential family (2026-11-09)
The agent-connection resolver accepted only ssagt_ credentials. OAuth connections hold ssoat_ token sets by design, so every MCP transport tool died on a prefix check for every OAuth connection on every tenant, while ssagt_ connections worked fine.
Check: when a second credential or token family exists, every resolver on the path must be audited for prefix or shape assumptions about the first family.

## LOCAL-3: Consume-then-validate ordering (2026-11-09)
The pair flow spent the single-use pending code BEFORE running the grant. A coded refusal then escaped as a 500 and the code was dead, reading to the user as "this link is not live anymore."
Check: validate and grant first, spend the single-use artifact last. A refusal must leave the artifact usable and produce a named, coded error screen, never a bare 500.

## LOCAL-4: Visual order is not layout order (2026-11-09)
The dashboard dock rendered pinned to the top on iOS: a flex column's bottom row displaced after resume/refresh, and the shell had no runtime verification of where the dock actually sat.
Check: critical chrome gets explicit order pins AND a runtime seat check with a bounded self-correction budget. "It rendered" is not proof of where it rendered.

## LOCAL-5: EXIF orientation stripped on recompress (standing rule, 2026-10-06)
Phone photos store rotation in an EXIF flag. Any resize/recompress that strips the flag without baking it in ships a sideways image.
Check: ImageOps.exif_transpose() runs FIRST in every image pipeline; final file is eyeballed, not just dimension-checked.

## LOCAL-6: Baked-in text garbles silently (standing rule, 2026-10-26)
Supplied or generated art misspells proper names (JEFFFERSON, REUNIION shipped to a customer). Eyeballing reads as clean.
Check: every proper name and baked-in word is spelled out letter by letter against the customer's source before anything ships.

## LOCAL-7: Mid-build deployment reads lie (2026-11-09)
A by-ID deployment read transiently reported READY while still BUILDING during the ChatGPT fix landings.
Check: claim a landing only after two consecutive READY reads by ID, merge SHA asserted, plus a behavior probe of the changed surface.

## IMPORTED-1: Quadratic accumulation in a reduce or loop (Netflix)
Copying an accumulated collection on every step (putAll inside a reduction) turns a linear build into O(N^2). Passes unit tests; only visible at real volume.
Check: any accumulation that copies the accumulator per iteration gets rewritten to a single-pass collect.

## IMPORTED-2: Regex evaluation per request on a hot path (Netflix)
A raw regex substitution ran on every request and took 46% of a service's CPU; a precomputed lookup table was 22x faster.
Check: regexes on request paths are compiled once at init at minimum; per-character work uses lookup tables, not pattern evaluation per call.

## IMPORTED-3: Heavy allocation per call (Netflix)
Constructing a fresh HashSet per incoming call consumed 47% of heap collections and fed OOM crashes, when the data object already had an internal lookup.
Check: allocations inside per-request code get questioned first; prefer existing lookup methods and cached structures over new containers per call.

## IMPORTED-4: Registry or config lookup per invocation (Netflix)
Looking up a metric counter from a registry on every call took 66% of CPU versus 0.3% for the actual business logic; the same misuse existed in three services at once.
Check: anything fetched from a registry, config store, or remote settings endpoint inside a hot function gets cached at initialization. When found once, grep for the same shape everywhere before fixing just the one site.
