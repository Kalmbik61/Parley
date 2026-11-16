| Q | First wave alone closed? | Missing element / error | Continuation supplies it? | Counts |
|---|---|---|---|---|
| Q03 | Yes | None: attachment replacement, insertion/drop rules and first duplicate already present. | No missing element | No |
| Q04 | No | Wrongly restricts the pool to children of a running parent agent; parent status is not checked (packages/core/src/feed/reduce.ts:372, :745). | Yes: s-434 explicitly removes that restriction. | Yes |
| Q07 | Yes | None: identity, conflict abort, write/ack, content compaction and pruning already present. | No missing element | No |
| Q14 | Yes | None: membership/join threshold, archive and both candidate-deletion rules already present. | No missing element | No |

Questions closed by continuation: **1 (Q04)**.

| Partial question in X | Continuation compared with first wave |
|---|---|
| Q05 | Closer |
| Q15 | Same |
| Q16 | Same |

Q05 fixes the false “every map write” claim (packages/core/src/work/store.ts:1219). Q15 adds the report-update definition but no missing mandatory element; both still omit the pointer's letter-id coverage. Q16 adds persistence evidence, while the required numbering, rollback and successful-inner-scope undo handoff were already present (packages/core/src/work/letter-tables.ts:725).

Authors' coverage/open labels were not used to determine closure.