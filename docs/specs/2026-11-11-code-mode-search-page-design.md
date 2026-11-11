# D3: code_search page size — design note

Author s-314 (Opus), room r-26 (assigned by s-292, m-7655). Design only. Base: `parley/w-0054/s-293` at 29326bfa (read-only).
**ACCEPTED**: s-296 CLEAR (m-7668); s-292 ACCEPT D3a and D3b (m-7669). The rulings:
- **Version.** D3 rides v4 as a SECOND commit on `parley/w-0054/exec-view`, after the envelope commit. That gives one bump and one v4 gate rerun. Each commit gets its own freeze, review and verify. s-306 builds the envelope (Rev 3) first, then D3.
- **D3b first-sentence rule (closed).**
  - A sentence ends at ". ", "! " or "? " followed by an uppercase letter, or at the end of the text.
  - "e.g. ", "i.e. ", "etc. " and a period before a digit do not end it.
  - Then the 120-char cap with `…` applies.
  - S6 includes descriptions with "e.g." and with a version number.
  - Before the freeze, the evidence lists all 49 resulting summaries for review.
- **Harness hunk** (the run.ts phase, CONSERVATION_PROCEDURE line 4): s-295's file. s-306 builds it and s-295 reviews it.

## 0. What the page spends tokens on

**Method.** I rendered pages with the real dist `code_search` (ranking, `summaryOf`, `buildPage`) over the 49-tool replacement list: `TOOLS` + `BROWSER_TOOLS` + 4 session-agent tools.
- Counts use js-tiktoken 1.0.21 o200k with a real-format apiRevision.
- Script `search2.mjs`, output `search2.out`, both in this scratchpad.
- Locally "parley" is 2409 B; the T9a replay page was 2644 B. The difference is the replay catalogue (availability strings and per-launch descriptions).

`code_search {query:"parley"}` (the T9a arm's default discovery): 8 items, 582 tok.
- **7 of the 8 items are `availability: "unavailable"`.** They are methods that `code_execute` cannot run and `code_docs` will not describe (`documentedRead` false): `browser_*`, `get_capacity`, `wait_for`.
  - Each costs 61–75 tok, because of a 200-char summary plus `effect` and `availability`. Together that is about 480 of the 582 tok.
  - The agent can do nothing with them through Code Mode. They are direct tools in its list, or not offered at all.
- The envelope is 64 tok, and the apiRevision alone is 39 of those.
- A blank query (the conservation phase's whole-catalogue read) has 30 items on page 1, 1934 tok. 27 of the 30 items are unavailable.

## 1. Change

1. **D3a: unavailable matches become names only.** The page gains `unavailable: string[]`, the names of matched entries whose availability is `unavailable`, in rank order. `items` keeps only `executable` and `documented` entries.
   - The agent still learns that such a name exists and is not a Code Mode method, so it says so or calls the direct tool. That is the instruction text in `code-mode-instructions.ts:66`.
2. **D3b (separable, recommended): a shorter summary.** `summaryOf` becomes the first sentence of the description, capped at 120 chars (it is 200 chars now). It keeps the existing `…` cut and the surrogate guard. `code_docs` still gives the full declaration.
3. **Unchanged:**
   - `apiRevision`, `kind`, `complete` and `nextCursor`;
   - the cursor format and its binding (revision, kind, request key);
   - the 8 KiB page budget;
   - ranking;
   - `complete` iff `nextCursor === null`;
   - the code_search descriptor and its request schema.

**Pagination.** The offset and limit count the combined ranked list, as today. A page is a slice of that list. Each entry in the slice goes either to `items` or to `unavailable`, keeping order within each array.
- `buildPage` still refuses an entry that cannot fit even alone, so no page silently loses an entry.
- `limit` counts entries of both kinds.

**Contract.**
- `SCHEMAS.searchPage` gains a required `unavailable: {type:'array', items: METHOD_NAME, maxItems: searchLimitMax-or-page-bound}`.
- A new cross-field check in `serializePage` and `parsePage`: no name appears in both arrays.
- `items[].availability` can no longer be `unavailable` on a search page. The enum narrows for search items only; docs items are unchanged.
- `SearchItem` stays a type; `buildPage('search', …)` takes the ranked entries and splits them.

**Rejected:**
- **A shorter apiRevision** (cm2 + 32 hex). It would save about 18 tok per search and per execute request, but it touches every revision regex and the instruction texts. That is too much churn for the gain.
- **Dropping `kind` or `complete`.** It would save 2–4 tok, and those fields are explicit-completeness markers.
- **Name-only matching.** It changes search semantics.

## 2. Cost (ESTIMATE, not measured)

| query | now tok | D3a | D3a+b |
|---|---:|---:|---:|
| "parley" (T9a default) | 582 | 139 | 129 |
| "get_map" | 239 | 130 | 99 |
| "read_room" | 100 | 104 | 104 |
| " " page 1 (conservation) | 1934 | 429 | 398 |

- On the replay's page (2644 B, about 645 tok by the same ratio), the discovery line drops to about 130–150 tok per session.
- A single-item page grows by about 4 tok, for the empty `unavailable:[]`.

## 3. Files

- `packages/core/src/mcp/code-mode/contracts.ts`: the `searchPage` schema, `SearchPage`, `buildPage('search')` splitting, and the `serializePage`/`parsePage` disjointness check.
- `packages/core/src/mcp/code-mode-tools.ts`: `search()` passes the ranked entries with their availability; `summaryOf` (D3b).
- Tests: `contracts.test.ts`, `code-mode-tools.test.ts`.
- Harness:
  - `tools/parley-token-benchmark-replay-run.ts:204-206` (the conservation phase) collects `items[].name` and then `unavailable[]` per page;
  - `CONSERVATION_PROCEDURE` line 4 text says so. That changes `CONSERVATION_PROCEDURE_SHA256`, which is reported in the report, not pinned in the goals; its test computes it.
- Spec §4, the `code_search` sentence: "returns method names… effect class, availability" becomes "runnable or documented methods with summary, effect and availability, and the names of matched methods unavailable here".

## 4. T9a

- **Conservation criteria:**
  - `catalogue.namesEqualOriginal` (judge.ts:320) compares sorted names, and it holds once the phase reads both arrays.
  - `orderEqualBetweenRuns` and `bytesEqualBetweenRuns` hold because the output is deterministic.
- **Goals and scripts unchanged.** The arm's `search['apiRevision']` read (arms.ts:520) is unchanged.
- **Accounting:** code_search bytes shrink on every replacement goal. It is reported as its own per-session line (D1).
- **Self-check:** a catalogue phase that reads only `items` must fail `namesEqualOriginal`. That is mutant H-S1.

## 5. Tests and mutants

**Tests**
- S1: "parley" gives `items` = [read_guide] and `unavailable` = the 7 names in rank order.
- S2: a blank query paged to the end. The union of `items` and `unavailable` over all pages equals the catalogue names; there are no duplicates; `complete` is only on the last page.
- S3: a cursor from page 1 continues correctly across a page boundary that splits the two kinds.
- S4: a name in both arrays is refused by `serializePage` and `parsePage`.
- S5: an `unavailable` availability inside `items` is refused.
- S6: the D3b summary is the first sentence; it is cut at 120 chars with `…`; a lone high surrogate is never left.
- S7: the page budget. An entry that cannot fit alone is still refused (unchanged), and an `unavailable` name always fits.
- S8: `limit` counts both kinds.

**Mutants**
- MS1: an unavailable entry is dropped instead of named → S1/S2 RED.
- MS2: unavailable names are left out of the offset count → S3 RED.
- MS3: the disjointness check is removed → S4 RED.
- MS4: the enum is not narrowed → S5 RED.
- MS5: summaryOf is not changed → S6 RED (D3b only).
- H-S1: the phase reads `items` only → `namesEqualOriginal` RED.

## 6. Risks

- **Clients of the search page:** only the T9a phase, and tests in the repo. No shipped launch exposes code_search with a broker yet.
- **An agent that relied on summaries of unavailable methods.** Those summaries are already in its tool list as direct-tool descriptions, or the method is not offered at all.
- **D3b shortens the text** the agent ranks by. If a first sentence is weak, the agent calls code_docs, which costs one more call. That is not measured.

## Not verified

- Every number is an estimate, rendered locally. None comes from the T9a run.
- The replay's per-launch descriptions were not rendered.
- How first sentences read across all 49 descriptions was not reviewed one by one.
