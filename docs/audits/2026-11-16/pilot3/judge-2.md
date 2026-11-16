Blind assessment at commit 9eabc014. Paths below are relative to /Users/kalmbik61/parley/pilot3-subject.

1. Per-question verdicts

| Q | X | Y | Note |
|---|---|---|---|
| Q01 | partly | partly | Both omit forgetting the stored tool name after completion (packages/core/src/feed/opencode/events.ts:139). |
| Q02 | closed | closed | Ordinal filtering, history offset and exact warning conditions match packages/core/src/feed/codex/apply-codex.ts:372. |
| Q03 | closed | closed | Attachment replacement, pointer anchoring, drop rule and first duplicate match packages/core/src/feed/mail-seed.ts:21. |
| Q04 | closed | partly | Y names nextId('permission') but omits the sequential permission:#N format/counter (packages/core/src/feed/reduce.ts:297). |
| Q05 | partly | partly | Both omit that the blocked letter carries the block note and requests an amended decision (packages/core/src/work/plan-effects.ts:142). |
| Q06 | closed | partly | Y omits that no fallback duty is assigned without a live lead (packages/core/src/work/plan-state.ts:108). |
| Q07 | closed | partly | Y omits acknowledgement removing content while retaining sha256 (packages/core/src/work/stored-texts.ts:51). |
| Q08 | wrong | closed | X says promotion-exempt items are unchanged; a changed dependency can reset them (packages/core/src/work/plan-state.ts:177). |
| Q09 | partly | partly | X omits ignored state directories; Y stops before core checks and supplies no source (packages/core/src/work/worktree.ts:870). |
| Q10 | closed | none | Y contains only 'In the main checkout:'; no filter is answered (packages/core/src/work/worktree-include.ts:91). |
| Q11 | closed | closed | Both meet the corrected rule: existing targets are skipped before the deadline check (packages/core/src/work/worktree-seed.ts:254). |
| Q12 | partly | partly | X omits the regular-file requirement beyond 'not directories'; Y omits validations and roots (packages/core/src/work/worktree.ts:667). |
| Q13 | partly | partly | X omits notification text; both omit metadata fields and absence of letter body (packages/core/src/mcp/inbox-watch.ts:62). |
| Q14 | closed | closed | Recipients and leave/archive candidate deletions match packages/core/src/work/letter-tables.ts:605. |
| Q15 | partly | partly | Both omit that pointer text and ids still include all non-deleted unread letters (packages/core/src/work/delivery.ts:295). |
| Q16 | partly | closed | X omits successful inner scopes transferring undo actions to the outer scope (packages/core/src/work/letter-tables.ts:725). |

2. Totals

| Answer | closed | partly | wrong | none |
|---|---:|---:|---:|---:|
| X | 8 | 7 | 1 | 0 |
| Y | 6 | 9 | 0 | 1 |

Omissions receive partly; Y's Q09 contains a correct preliminary host check, so it is partly despite its truncation. Y's Q10 contains only a heading, so it is none. Submission-side verifier labels were not used as evidence.

3. Key corrections

Q08: promotion exemption does not prevent a dependency-driven reset. The key's unconditional “It is not reset and is stamped” needs qualification. packages/core/src/work/plan-state.ts:177 checks `!changed.has(item.id) && item.after.some((id) => changed.has(id))`, then :178 executes `changed.add(item.id);` without excluding promotionExempt. packages/core/src/work/plans.ts:482 preserves progress only under `previous && !changed.has(item.id)`; the revision stamp is assigned inside that branch at :492. X's unconditional preservation claim is wrong; Y explicitly handles this case.

Q11: “every later path is reported as timeout” excludes targets that already exist. packages/core/src/work/worktree-seed.ts:254 first executes `if (await lstat(target).then(() => true, () => false)) continue;`; only afterwards does :256 check `expired || remaining <= 0`. Both answers correctly give existing-target skips priority.

Q07 clarification: X correctly says exports are excluded from overflow measurement (packages/core/src/work/plan-effects.ts:405), but overflow cleanup still removes eligible written exports without an age threshold (:339, :413). The key explicitly makes this extra overflow case optional for closure, so its omission does not lower X's verdict.

4. Not verified

No execution, builds, tests, fixtures or browser checks: this task requires source reading only. Additional claims were sampled, not exhaustively checked; samples included host launch/history and worktree guards, staging, snapshot acknowledgement, watcher deletion handling and rollback. No files were changed and no sessions were created. No forbidden audit/private locations or answer provenance were opened.

Impact card — Goal: blind code-answer assessment. Behaviour: content judged by the same corrected key. Numbers: 32 question verdicts; X 8 closed, Y 6 closed. Screens: not applicable. For the human: omissions and the substantive error are located above. Risk: selective checking of extra claims. Cost: token/time cost not measured. Verdict: assessment complete; neither answer closes every question.