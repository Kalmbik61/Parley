Stage 2 — continuation attribution, using the same key with the established corrections.

H = packages/host/src; SS = H/sessions/sessions-service.ts; SV = H/stuck/stuck-service.ts; WK = H/works/works-service.ts; CA = packages/core/src/work/autonomous.ts. “No gap” means the first-wave submission already sufficed.

| Q | First wave alone closed? | Missing/corrected element | Present in continuation? | Count |
|---|---|---|---|---|
| Q01 | Yes | No gap: exclusions, ignored events, background Stop and fresh sleeping/resume check already supplied (SS:2721). | No gap to fill; continuation adds detail. | 0 |
| Q11 | No | First wave incorrectly says all other outcomes are merely recorded; recordCheck can halt for budget (CA:997,346). | Yes: s-416 explicitly supplies this path and corrects the predecessor. | 1 |
| Q12 | No | First wave incorrectly says attempt status does NOT change; haltDraft aborts it and returns its item (CA:260,261). | Yes: s-416 explicitly corrects both state changes. | 1 |
| Q13 | Yes | No gap: immediate kinds, reportMs/default and back line/letter conditions already supplied (SV:74,118,274,277). Env wiring was optional in the key. | No gap to fill; s-417 verifies the env wiring. | 0 |
| Q15 | Yes | No gap: immediate non-structural notify, window routes, 50-ms batch, pending structure and 2000-ms cap already supplied (WK:889,806,816,901). | No gap to fill; s-417 adds verification/detail. | 0 |

Questions closed by continuation: **2 — Q11 and Q12**, rather than all five attributed questions.

| Q | Continuation versus first wave |
|---|---|
| Q02 | unchanged |
| Q04 | closer |
| Q08 | closer |

Not verified: no runtime checks; extra claims sampled. No edits or new sessions.

Impact card — Goal: attribution. Behaviour: compare submissions against the same corrected key. Numbers: 2 of 5 attributed closures qualify. Screens: not measured (no UI task). For the human: separate corrections from confirmations. Risk: extra claims sampled. Cost: not measured (no resource accounting). Verdict: complete.