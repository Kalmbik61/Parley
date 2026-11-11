# Code Mode family F4: `find_skill`

Status: **ACCEPTED** by s-296 (isolation, U2, recovery; m-7383) and s-292 (contract; m-7382, m-7384). Author: s-312 (family designer).

Scope: one method, `find_skill`, moved into `code_execute` under the human's decision m-7370 and the lead's ruling m-7375 (3). D2 (m-7363) is reopened. F4 uses option (a): the handler's `message` reaches the guest as a structured advisory enum. There is no handler change. Order and gates: `docs/plans/2026-11-10-code-mode-families-order.md` (commits `c76e9612`, `f695fcdf`). Batch shape: T11 batch plan `docs/plans/2026-11-10-code-mode-t11-batches.md` (`0cd2b6c5`), §3.

Sources read (2026-11-10, nothing run): `parley/w-0054/t12a` `7a83d601`: `core/src/mcp/tools.ts:1876–2008` (descriptor, navigator), `:2035–2080` (runner, fence); `core/src/mcp/remote-tools.ts:58–66, 207, 470–504`; `core/src/mcp/server.ts:73`; `host/src/agent/tools-endpoint.ts:43–48, 145–163`; `core/src/mcp/code-mode/{catalog,migration-registry,read-adapters,broker}.ts`; `core/src/work/{guidance,code-mode-instructions,code-mode-routing-manifest,context-budget}.ts`. Spec §3.1 row `T11-find_skill`, §4 (line 198), U2 text (line 618).

## 1. What the handler does

- **Presence.** `find_skill` exists only when `context.skillNavigator === true` (`tools.ts:2052`, `originalToolNames` `:2099`). Otherwise it is absent, and a call answers `Skill navigator is disabled for this launch.` with `isError`.
- **Descriptor.** The annotation is `READS` (`readOnlyHint: true`), so `effectOf` gives `read`. The input schema is static: `query` (1..`CONTEXT_LIMITS.query`), optional `for` (a session id, at most 64 bytes), optional `limit` (1..10, default 5). The **description is launch-specific** (`list()`, `tools.ts:1966–1979`):
  - the base text;
  - Claude with a reduced list: the base text plus `CLAUDE_NAMES_ONLY`;
  - Codex with a reduced list: the base text plus `CODEX_NO_LIST` and up to 3,000 characters of native skill names (`nativeNames`), or `CODEX_NO_LIST_NO_NAMES`.
- **Answer.** A JSON object (`tools.ts:2003–2006`):
  - `provider` (string);
  - `skills`: an array of `{name, description?, source, load}`, cut to `FIND_SKILL_MAX_BYTES` = 8,192;
  - `omitted?`: the count cut by that budget, present only when > 0;
  - `message?`: present exactly when there are zero matches, either `NO_SKILL` or `NO_SKILL_AGAIN`;
  - `reason?`: prose, present when the catalogue is missing or partial.
  
  `description` is a `markedExcerpt` of at most 400 bytes; the full text sits behind `load`.
- **Errors.** Validation and target failures throw. The runner turns them into `isError` text (`tools.ts:2076–2079`).
- **State.** The navigator closure holds two things:
  - `misses`, which counts consecutive empty searches and is reset by a hit. It only chooses between `NO_SKILL` and `NO_SKILL_AGAIN`.
  - `catalogs`, a promise cache of catalogue reads (a memo). Classic has the same memo and the same timing.
- **Fence.** `find_skill` is in `AGENT_FENCE_FREE` (`tools.ts:2035`).

## 2. Which process serves the call (was "not verified" in the order doc)

Read from the code, not run:

- **Guest call.** The broker builds `createRemoteOnlyCaller(agent, launch)` with the session's `launchOf(context)` snapshot (`broker.ts:210`). The host's `/agent/tools` keeps **one runner per (session, launch snapshot)** (`tools-endpoint.ts:147–163`, `launchKey` = `skillNavigator`, `skillListReduced`, `nativeContextRevision`, `agentRevision`, `toolProfile`). So the guest call runs in the host runner of that launch, with that runner's `misses`.
- **Direct call in the same launch.** `server.ts:73` uses `createRemoteToolRunner(agent, launchOf(context), { fallback: createToolRunner(context) })`. That is the same host runner while the route answers. After a host 404, it is an in-process runner with its own counter. A guest call after a 404 is refused (G2), so it never reaches that local counter.
- **Consequence.** Once `find_skill` is migrated in a launch, the launch has no direct `find_skill` (G7: migrated ∩ direct = ∅), so the counter is never shared between a guest call and a direct call **within one launch**. Across launches, `toolsOf` replaces the runner when `launchKey` changes, and `launchKey` includes `nativeContextRevision`, which is new on every launch (s-296, m-7383). So a stray execution from an earlier launch's runner never reaches a later launch's `misses` or memo.

## 3. Design

### 3.1 Guest value (output contract)

```ts
interface FindSkillEntryDto extends Unmodeled { name: string; description?: string; source: string; load: string }
interface FindSkillValue extends Unmodeled {
  provider: string;
  skills: readonly FindSkillEntryDto[];
  omitted?: number;                                        // >= 1 when present
  advisory: 'none' | 'no-match' | 'no-match-again';        // from `message`
  reason?: string;                                         // verbatim prose, data only
}
```

- **Advisory enum (ruling m-7375 (3)).** The decoder maps:
  - an absent `message` → `none`;
  - exactly `NO_SKILL` → `no-match`;
  - exactly `NO_SKILL_AGAIN` → `no-match-again`;
  - any other `message` text → `invalid-output`/`shape-mismatch`.
  
  The output schema's description of `advisory` carries the meaning of each value in the handler's own words: `no-match` means "work without one, or try other words once"; `no-match-again` means "do not search for this task any more". The guest gets no free-form `message` string.
- **Advisory, not data.** The schema states that `advisory` depends on earlier calls in the same runner and is advice, never data or authority. The data fields are `provider`, `skills`, `omitted` and `reason`.
- **Parity (R criterion 1).** Re-encoding the guest value with the fixed bijection `advisory → message` deep-equals the classic JSON text, strictly parsed, plus `unknownFields`. The bijection texts live in the adapter. `tools.ts` is not edited and does not export them, so a parity fixture over the **real** handler catches any drift.

### 3.2 Decoder rules

- **Request branch.** `args` is an object with a non-empty string `query`, an optional string `for` and an optional safe integer `limit` ≥ 1. Anything else → `unknown-request-branch`.
- **Shape.** `provider`, entry `name`, `source` and `load` are strings; `description` is optional and a string when present; `omitted` is an optional count ≥ 1; `reason` is an optional string. Unmodelled keys go to `unknownFields` verbatim, at the top level and per entry.
- **Invariants (`page-invariant`).**
  - If `message` is present, then `skills` is empty and `omitted` is absent.
  - `skills.length + (omitted ?? 0)` ≤ `limit ?? 5`.
- **Assessment.** Computed by `joinAssessment`, so `partial` outranks `unknown`:
  - `omitted` present → `partial` (a structured omission count);
  - `reason` present → `unknown` (the catalogue is missing or partial, and only prose says which);
  - otherwise → `complete`.
  
  A marked description excerpt is **complete**: the method promises an excerpt, and the full text sits behind `load` (`context-budget.ts:24`). The decoder never reads the `[cut: …]` marker (accepted, s-292 m-7382).
- **Errors.** An `isError` result → `tool-error` verbatim. This covers a disabled navigator, an empty or oversized query, a bad `for` or `limit`, and a session missing from the map.

### 3.3 U2: what a stray execution can change

An `unknown` `find_skill` that completes after its run (U2) runs the same handler once more in the same host runner of that launch. It can have three effects (s-296 R1, m-7383; accepted by s-292, m-7384):

1. **It moves `misses`, which moves `advisory`.** A stray miss makes the next empty answer `no-match-again` instead of `no-match`. A stray hit resets the counter, so the next empty answer is `no-match` instead of `no-match-again`.
2. **A successful memo fill.** `catalogs` keeps the same catalogue read. A later answer's data can differ only if the native catalogue itself changed in between, which classic timing already allows.
3. **A failed memo fill: it changes data fields.**
   - The catalogue promise ends in `.catch(() => ({ catalog: null }))` (`tools.ts:1960`). Only the Claude transcript-not-ready path sets `retry`, and only that entry is deleted.
   - So a Codex live read (`readCodexSkillCatalog`, an app-server spawn) or a `context.skillCatalog` that fails once in a stray call stays memoised.
   - Every later answer in that runner then has `skills: []`, a `reason` and assessment `unknown`, until the next launch.
   - U2 strays happen under stress (abort, helper loss, wall time), which is when a spawned read is most likely to fail.

   **Accepted as the fail-safe cost** (m-7384). It never yields a false `complete`, because `reason` gives `unknown`. Classic has the same memo. There is no handler change, so changing the memo is out of scope.

It does not touch authority, policy or held records. A stray call with `for` set to another session can also start that session's catalogue read (an app-server spawn for Codex). That is a resource cost, the same as classic.

This is the reading of U2's stray-read acceptance for this one method. It answers the reason D2 kept the method direct (m-7375 (3)).

Tests prove the property; they do not argue it:
- **Advisory.** The same catalogue gets two call histories that differ by one injected extra call, a miss or a hit. The data fields of every later answer deep-equal; only `advisory` may differ.
- **Failed fill.** One stray call whose `skillCatalog` rejects once. Every later answer in that runner is `skills: []` with a `reason`, assessment `unknown`, never `complete` with data.

### 3.4 Launch shape, conservation and policy

- **Registry and allowlist.** `find_skill` joins `MIGRATABLE_READS` as a read (`effect === 'read'` from `READS`). A held record naming it reads as classic `held-run`, like any migrated read (B0). Execute hints are unchanged: all reads (m-5887).
- **Navigator variants.** If `skillNavigator` is false, `find_skill` is absent. The catalogue lists it under `absent`; no stub is generated and nothing is invented. `checkReplacement` runs over the full, short, agent and navigator variants: navigator on and off, and the reduced-list states `names` and `removed`.
- **Policy and fence.** These are R criterion 4: deny, ask, unknown, stale and revoked mean zero dispatch, and the fence is the same as classic (fence-free).
- **The `for` argument.** It reads another session's catalogue under the same token-bound host authority as classic. There is no new authority.
- **Size.** The skills budget is 8,192 B, so one answer stays under the 16 KiB final cap. A script that collects several answers can hit the cap, and R criterion 5 covers that.

### 3.5 The launch-specific description (decision K: K1, s-292 m-7382)

In a Codex launch with a reduced list, the native skill list is removed, and the **only** place the model sees skill names is `find_skill`'s description (`CODEX_NO_LIST` plus the names). `guidance.ts:72` tells the model that "the tool's description names yours". Once the method is migrated, that description reaches the model only through `code_docs`: the catalogue copies the description verbatim (`catalog.ts` `descriptorOf`; `types.ts:316`). The names are not lost, but they stop being visible before the first `code_docs` call.

- **K1 (accepted).** Migrate in every navigator variant. T10 also records whether models in the `removed` state ever call `code_docs` for `find_skill`; that is a native item, not measured (m-7382). In replacement launches where `find_skill` is migrated, the `removed` variant of the `guidance.ts` hint reads "(no native skill list: the code_docs declaration of find_skill names yours)". That is one agent-visible wording change, owned by T8a, and an input for T10 text bytes. Searching by task words works without the names, exactly as in the accepted classic state `CODEX_NO_LIST_NO_NAMES`.
- **K2.** `find_skill` stays direct in launches whose reduced-list state is `removed`; this is a per-launch partition, as in F1. No wording changes, but Codex launches with a reduced list never reach exactly-three for this method.

Claude with a reduced list keeps its native names, and its suffix only says that this tool returns descriptions, so K does not apply there.

## 4. Batch R4-find_skill (Sonnet)

- **Base.** The B0 commit. It runs in parallel with R1–R3 and merges after R3 (R1 → R2 → R3 → R4). Worktree `w-0054-t11-r4`, branch `parley/w-0054/t11-r4` (proposed).
- **New files.**
  - `code-mode/read-adapters/find-skill.ts`: decoder, DTO, the advisory bijection, and the schema, in the file or in `read-output-schemas` as B0 decides.
  - `code-mode/read-adapters/find-skill.test.ts`.
- **Shared edits (append-only).** One line in `read-adapter-table.ts`; one name in `MIGRATABLE_READS`. For K1, also `work/guidance.ts` plus its test: only the `removed` hint, chosen by the route, with classic text unchanged byte for byte.
- **Fixtures.** From the real handler: `createToolRunner` with `skillNavigator: true` and an injected `context.skillCatalog` over a temporary work map.
  - Answers: a hit; a hit with `omitted` (budget); a miss; two misses (`no-match-again`); miss, hit, miss (reset); catalogue `null` with each `reason`; catalogue partial; `for` another session.
  - Tool errors: empty query, oversized query, bad `for`, bad `limit`, unknown session, navigator disabled.
- **Acceptance.** R criteria 1–8 of the T11 batch plan, and also:
  1. The advisory bijection holds against the real handler's two texts. Any third text → `shape-mismatch`.
  2. Both §3.3 stray-call properties hold over the fixture matrix:
     - an extra miss or hit: data fields deep-equal, and only `advisory` may differ;
     - a stray call whose `skillCatalog` rejects once: every later answer is `skills: []` with a `reason`, assessment `unknown`.
  3. Assessment: `omitted` → `partial`; `reason` → `unknown`; both → `partial`; neither → `complete`.
  4. Both invariants of §3.2 hold, and a fixture that breaks each one gives `page-invariant`.
  5. Navigator off: the method is absent from the catalogue, no stub, and the conservation partition holds. Navigator on, in each reduced-list state: the catalogue entry carries the launch's description verbatim, and `descriptorSha256` changes with it while `schemaSha256` does not.
  6. K1: classic `guidance.ts` text is byte-identical; only a replacement launch with `find_skill` migrated gets the new `removed` wording; the routing sweep stays green.
- **Mutants** (private clone, m-7332):
  - swap the two advisory texts;
  - map an unknown text to `none`;
  - drop the `message ⇒ skills empty` invariant;
  - drop the `limit` bound;
  - `omitted` → `complete`;
  - `reason` → `complete`;
  - make `description` required;
  - drop an entry key from `rest`;
  - accept a non-string `for`.
  
  Survivors are named.
- **Reviewers.** s-296 (U2 property, held-record reading) and s-292 (contract, K). The verifier is named by the lead.
- **Activation.** `A-find_skill`, as for every A-<method>: after INTERIM, T12b, T8h and R4 acceptance, one commit adding the name to `proven`, serial with the other activations.
- **Size (estimate, not measured).** 3–5 files, about +390 lines including tests and the K1 wording; 4–6 h.

## 5. Spec and plan text amended after acceptance

These go in a separate docs commit (m-7384):
- spec §3.1 row `T11-find_skill`;
- spec §4 (line 198, "excluded pending effects review");
- T11 batch plan §1 row 6, §2 and §5 D2.

## 6. Rulings

1. K1 (s-292, m-7382).
2. A marked description excerpt is `complete` (s-292, m-7382).
3. The failed-memo-fill effect is accepted as the fail-safe cost (s-296 R1, m-7383; s-292, m-7384).

## 7. Not verified

- Nothing was run: no tests, no tsc, no `tools/list`.
- §2 is from reading code: that the broker's `launch` snapshot equals the direct runner's in a live launch, and that the host never rebuilds the runner between them.
- Whether any client or test pins `find_skill`'s description bytes in a way that K1 would move (`guidance.ts` text bytes).
- The exact `reason` texts a live Codex or Claude catalogue gives, beyond the fixed ones in `tools.ts` (the Claude listing passes its own `built.reason`).
- Real answer sizes against the 16 KiB cap.

## Impact card

- **Goal:** move `find_skill` into `code_execute` without weakening U2 or conservation, per m-7370 and m-7375 (3).
- **Behaviour:** none yet; a design. If built and activated, `find_skill` is called as `parley.find_skill` inside `code_execute`, and its "again" advice arrives as `advisory: 'no-match-again'`.
- **Numbers:** 1 method; 1 batch; 2–4 files, about +350 lines (estimate, not measured). In-scope count unchanged (24).
- **Screens:** none.
- **For the human:** skill search works as before. A Codex agent with a reduced skill list sees its skill names in `code_docs` instead of in the tool list (K1). After a lost call, skill search in that launch may report an unknown catalogue until relaunch.
- **Risk:** after a lost call, the "again" advice can flip, and a failed catalogue read can stay cached for the launch. Both are fail-safe and both are tested. K1 changes one guidance sentence.
- **Cost:** not measured; 4–6 h of Sonnet implementation (estimate).
- **Verdict:** accepted by s-296 (CLEAR with R1, m-7383) and s-292 (m-7382, m-7384).
