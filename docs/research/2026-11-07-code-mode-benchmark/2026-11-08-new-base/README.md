# 2026-11-08 offline baseline at 19b4444e

Status: r2 identifier-sanitized packet, measured and frozen for independent s-294 verification and s-290 review, not accepted yet. Assigned by m-5163; transcript boundary clarified by m-5193. No product source edits, live host calls, provider runs or paid calls. The five observed chains are historical transcript data, not executions of this source revision.

## Source and method

Source commit: `19b4444e2c526131433dab3f1d5d3eccadefedd7`, read-only from s-293. An immutable `git archive` snapshot, rather than its dirty working files, supplied all project inputs. Every bundled project source hash was checked against `git show` at that commit. No repository `dist` was loaded. `schema-evidence.json` records 110 relevant/loaded source hashes and 319 loaded dependency-file hashes, plus fresh bundle and encoder fingerprints. The source worktree's in-progress T6 files were not used or changed.

Serialization matches design Appendix A: source-order `JSON.stringify(toolArray)`, no formatting or newline; exact UTF-8 bytes via `Buffer.byteLength`; actual `js-tiktoken@1.0.21`, encoder `o200k_base`, `encode(text, [], [])`. These are fixed-encoder corpus counts, NOT provider context or billable token counts. SDK version 1.30.0; fresh bundler esbuild 0.25.12. Primary Node 22.23.3 and separate Node 22.16.0 runs matched corpus bytes/hashes, token counts and bundle bytes. Each Node passed eight SDK in-memory and eight raw-stdio `tools/list` parity cases; raw JSON-RPC lines include request id 2 and LF and are separately measured. SDK parsed-property order is separately recorded; its bytes are not silently substituted for source/wire order.

All list probes use synthetic isolated work/project stores, a Claude fixture identity, channel notifications disabled and a dummy unreachable agent URL. Only local list requests run; fetch is replaced with a refusal, and no business method executes. Navigator-base runtime parity is for this synthetic Claude fixture. Reduced Claude and unavailable-name Codex navigator descriptors are separately serialized source projections; they are not an actual Codex catalogue observation. Available native names and other launch configurations may change navigator text.

## New source-order descriptor corpus

| Profile | Tools | UTF-8 bytes | o200k_base tokens |
| --- | ---: | ---: | ---: |
| full-runner | 30 | 22,160 | 5,453 |
| short-runner | 27 | 20,594 | 5,078 |
| full-runner-navigator-base | 31 | 22,891 | 5,611 |
| short-runner-navigator-base | 28 | 21,325 | 5,236 |
| full-server-agent | 49 | 43,063 | 10,520 |
| short-server-agent | 46 | 41,497 | 10,145 |
| full-server-agent-navigator-base | 50 | 43,794 | 10,678 |
| short-server-agent-navigator-base | 47 | 42,228 | 10,303 |

| Component / diagnostic corpus | Tools | UTF-8 bytes | o200k_base tokens |
| --- | ---: | ---: | ---: |
| browser | 15 | 17,020 | 4,153 |
| create-session | 1 | 1,172 | 274 |
| session-level | 4 | 3,885 | 918 |
| navigator-base | 1 | 732 | 160 |
| navigator-claude-reduced | 1 | 809 | 174 |
| navigator-codex-reduced-unavailable | 1 | 823 | 179 |
| full-legacy-size-corpus | 31 | 23,331 | 5,725 |
| short-legacy-size-corpus | 28 | 21,765 | 5,350 |

The existing `tools-size.test.ts` main `ALL_TOOLS` is `TOOLS + create_session`; it excludes browser and navigator and also omits `request_agent_switch`, `create_swarm`, `swarm_add`. Swarm descriptions/schemas have a separate two-tool test there. It is not the agent server listing; the actual server adds browser tools and all four session-level tools. New `browser_close` raises the browser set to 15. Navigator is optional and provider/context-dependent. `corpus/` contains exact descriptor arrays and raw stdio lines, with no transcript payload.

## Change from the accepted historical f7978af8 corpus

Historical numbers in design §2.1–§2.3 and Appendix A remain unchanged. Historical source hashes were rechecked against git commit `f7978af8156cfb426016f999fb6d36798adf7d73`, and stored historical corpus bytes against their recorded SHA-256. `historical-comparison.json` embeds the old/new statistics and deltas; no old corpus is overwritten.

| Corpus | Tool delta | UTF-8 byte delta | Fixed-encoder token delta |
| --- | ---: | ---: | ---: |
| full-runner | +4 | +2,450 | +616 |
| short-runner | +4 | +2,450 | +616 |
| full-server-agent | +8 | +5,958 | +1,447 |
| short-server-agent | +8 | +5,958 | +1,447 |
| browser | +1 | +795 | +187 |
| create-session | +0 | +0 | +0 |

These are increases in serialized source schema surface, not a savings measurement. Provider loading/deferred discovery, caches, outer wrappers, reasoning/context, billing and monetary cost remain unknown. T10 owns value/savings evaluation. The new source agrees with the accepted T3a-refresh tool counts, but this packet measures bytes/tokens separately.

## Five genuine adjacent transcript chains

Selection examined seven pinned task-project native Claude transcript prefixes with call timestamps from 2026-11-07 onward: 766 sequential adjacent MCP pairs, of which only 1 pair contains a parseable overview `schemaVersion: 3` result. Five distinct pair shapes were measured; only the first has explicit overview-version evidence. This is a bounded local search, not a claim that only one such chain exists globally. The other four have no overview-version evidence. All transcript host/server revisions are unknown. No synthetic replay was performed.

| Chain | Actual chronological calls | Input tokens | Result-content tokens | Intermediate-result tokens |
| --- | --- | ---: | ---: | ---: |
| overview-v3-report | get_map → report | 184 | 5,076 | 4,852 |
| map-detail-chain | get_map → get_map | 23 | 756 | 315 |
| session-room | create_session → add_to_room | 602 | 50 | 24 |
| inbox-room | check_inbox → read_room | 18 | 2,211 | 21 |
| backlog-list-suggest | backlog_list → backlog_suggest | 289 | 1,688 | 1,632 |

Input and result-content counts use `JSON.stringify(tool_use.input)` and `JSON.stringify(tool_result.content)` respectively, with the same fixed encoder. All tool types participate in adjacency checks; each selected result precedes the next call. Opaque stable transcript IDs, line/block numbers, native call/message IDs, timestamps, immutable prefix length/hash and per-input/result hashes are in `chain-selection.json`/`chain-evidence.json`. No absolute transcript paths, session UUIDs or local account names are published; only metadata/hashes/counts are published; message, task and result payloads remain outside the repository.

The overview pair has all five v3 collection keys. The map-detail pair is intentionally not repaired: its first call supplied unsupported `detail`, is an actual recorded tool error and fails the new source input schema (`additionalProperties`); its second call is a valid session/task-field request. Thus it is not a successful new-base drilldown reproduction. Nine of ten selected inputs validate offline against the new source declarations using Ajv 8.20.0, no coercion/defaults/removal; that checks input shape only. Output envelopes are described by key names/branch metadata and compared to the pinned source; no output-schema or semantic-execution equivalence is claimed.

Current pinned-source comparison: overview v3 plus `collections` matches `context-pages.ts`; session/task text envelope matches the field branch; `read_room` has messages/page; backlog has its original list/suggestion envelopes; session creation and room invitation retain their source-specific host authority. Host state, authorization, response contents and exact deployed revision are not reproducible from these transcripts. Browser, roles→creation→wait and map→guide families from Appendix A were not reproduced as those exact chains in this bounded contemporary selection. The current inbox chain is inbox→room, and the map pair includes a refusal. Their old measured counts remain historical rather than being forced into new shapes.

## R2 identifier/privacy boundary

All 41 published files are scanned for the local home/account identifier and session-UUID patterns: zero matches. Transcript references use stable opaque prefix-hash IDs; the path-to-ID map stays outside the repository. Dependency-file identities are relative to an external dependency root. Corpus bytes, tokenizer counts, transcript prefix hashes and line metadata are unchanged. Only one chain is confirmed to use overview v3; one selected pair retains an actual refusal.

## Reproduction

Copy this directory to a fresh `/tmp` run directory; do not regenerate into the frozen repository artifact. Provide a git repository containing the pinned commit and its installed dependency root (the measured s-293 worktree supplied dependencies). Extract the source snapshot with:

```sh
mkdir -p "$RUN/source"
git -C "$REPO" archive 19b4444e2c526131433dab3f1d5d3eccadefedd7 packages/core/src packages/host/src/agent/tools-endpoint.ts packages/core/package.json pnpm-lock.yaml package.json | tar -x -C "$RUN/source"
TOKENIZER_ROOT="$TOKENIZER_PACKAGE" "$NODE22" "$RUN/schema.mjs" "$RUN/source" "$DEPS"
TOKENIZER_ROOT="$TOKENIZER_PACKAGE" BASELINE_DEPS="$DEPS" TRANSCRIPT_MAP="$PRIVATE_MAP" "$NODE22" "$RUN/chains.mjs"
```

`RUN`, `REPO`, `DEPS`, `NODE22` and `TOKENIZER_PACKAGE` are task-specific paths: select the copied artifact directory, repository, installed dependency worktree, explicit supported Node executable and the `js-tiktoken@1.0.21` package directory. No repo dependency edits are needed; the measurement reused an existing temporary tokenizer install. If absent, install that exact tokenizer into a separate `/tmp` package directory. `schema.mjs` refuses dependency-version drift and rechecks bundled project source bytes. `chains.mjs` verifies every transcript prefix, adjacency, candidate counts and selected result linkage before emitting measurements. Transcript paths/session UUIDs are not tracked. Supply a private external JSON map via `TRANSCRIPT_MAP` (`PRIVATE_MAP` in the command), mapping opaque `transcriptId` values to local native transcript files; keep that map outside the repository. IDs are stable prefix-hash references, and the script verifies prefix lengths/hashes before reading calls. Dependency-file references are relative to the supplied dependency root. Native transcript access and this external map are required to reproduce chain counts; hashes alone cannot recover private payloads. `runtime-crosscheck.json` records the separate supported-Node comparison.

## Impact card

- Goal: refresh the source-schema baseline after the base merge, preserving historical evidence.
- Behaviour: offline research artifacts and doc links only; no Code Mode activation or capability change.
- Numbers: eight source profiles, eight SDK and eight stdio parity cases per Node; five genuine chains, one with explicit v3 overview evidence; no new provider metrics.
- Screens: not measured; no UI scope.
- For the human: schema growth is reported as growth; transcript limitations and the refused request are retained.
- Risk: transcript host revision/semantics are unknown; fixture list parity is not native-client or live-host execution proof.
- Cost: no paid calls; monetary cost not measured. No billing inference from fixed-encoder counts.
- Verdict: measurement packet frozen for independent review; savings remain for T10.

## Not verified

Provider billable/context counts, actual native loading/caching and savings; a live host at 19b4444e; five confirmed v3-overview chains (only one is confirmed); runtime execution of the selected chains; authorization/output equivalence; available-name Codex navigator variants; a packaged app. No production call, paid run, push or commit of this packet occurred.
