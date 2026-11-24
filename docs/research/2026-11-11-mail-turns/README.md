# Fewer mail turns: measurements (2026-11-11)

Plan: `docs/plans/2026-11-11-fewer-mail-turns-plan.md` (on `feat/fewer-mail-turns`). Harness: `tools/mail-turns-bench.ts`.
Every value below comes from `results.json`. The raw provider logs (`runs/<id>/`) are kept on the machine that ran the measurement and are not committed: they are whole session transcripts and include the operator's own Claude Code and Codex configuration.

## What was measured and how

- Each run starts a fresh host in an isolated `PARLEY_HOME` and one real session (Claude `sonnet` or Codex `gpt-6.1-sol`, effort
  medium) in a throwaway git project under `/private/tmp`. Project MCP servers are denied for the run; the user's real Parley
  home is not used.
- The counterpart is the harness: it sends direct letters as the human through the host's `rooms.send`. There is no second model.
- Scenario W (waiting): the session sends `ready`, then waits for mail. The harness sends `Number: 41` at 20 s, `Number: 57` 150 s
  later, `Number: 73` 150 s later and `STOP` 20 s later. The session answers each number with the number plus one and calls
  `report` on `STOP`.
- Scenario P (pointer): the session calls `report` and ends its turn. The harness sends `Number: 118` 30 s after the turn end and
  `Number: 236` 30 s after the next turn end. The session answers each with the number plus one.
- Counts come from the provider's own log: Claude transcript (responses are distinct assistant message ids), Codex rollout
  (responses are `token_count` records; Parley calls are read from the `exec` scripts; turn ends from `task_complete`).
- Weighted cost = input + 0.1 cache read + 1.25 cache write + 5 output. These are the plan's weights, not provider billing.
- A run stops at 40 responses or 15 minutes. No run with a log reached the response limit; one Codex row first recorded as `time-limit` is explained below.

## Arms

| arm | build |
|---|---|
| baseline | `origin/master` 79428593 |
| treatment | `feat/fewer-mail-turns` at 6a0a838b (M1: background threshold, M2: mail with the wake pointer) |
| phase2 | `feat/fewer-mail-turns` at b153f12c (treatment plus the guidance change) |

## Results

Each cell is the median, then every value in the order of the run ids. Percentages are not given.

### Claude, scenario W

| arm | runs with a log | responses | backgrounded results | check_inbox calls | weighted cost | input | cache read | cache write | output | wall s |
|---|---:|---|---|---|---|---|---|---|---|---|
| baseline | 3 of 7 | 10 (10, 8, 10) | 2 (2, 2, 2) | 0 (0, 0, 0) | 100888 (100888, 89718, 101032) | 20 (20, 16, 20) | 553908 (553908, 438644, 554820) | 32240 (32150, 32474, 32240) | 1049 (1058, 1049, 1046) | 347 (347, 347, 347) |
| treatment | 3 of 3 | 11 (10, 11, 11) | 0 (0, 0, 0) | 0 (0, 0, 0) | 104862 (97904, 104862, 105074) | 22 (20, 22, 22) | 612486 (551523, 612486, 613700) | 31294 (30993, 31325, 31294) | 887 (798, 887, 913) | 347 (347, 348, 346) |
| phase2 | 3 of 3 | 7 (7, 7, 7) | 0 (0, 0, 0) | 0 (0, 0, 0) | 81894 (81429, 81894, 82867) | 14 (14, 14, 14) | 377260 (376586, 377260, 379064) | 31611 (31541, 31611, 32085) | 928 (866, 928, 968) | 348 (346, 349, 348) |

### Claude, scenario P

| arm | runs with a log | responses | backgrounded results | check_inbox calls | weighted cost | input | cache read | cache write | output | wall s |
|---|---:|---|---|---|---|---|---|---|---|---|
| baseline | 3 of 3 | 8 (9, 8, 8) | 0 (0, 0, 0) | 2 (2, 2, 2) | 83072 (89953, 83072, 82928) | 20 (22, 20, 20) | 433716 (492464, 433716, 432159) | 30314 (30756, 30300, 30314) | 361 (448, 361, 360) | 79 (79, 80, 79) |
| treatment | 3 of 3 | 6 (6, 6, 7) | 0 (0, 0, 0) | 0 (0, 0, 0) | 70770 (70770, 70694, 77943) | 12 (12, 12, 14) | 316210 (316210, 314619, 376376) | 30256 (30238, 30256, 30737) | 280 (268, 280, 374) | 90 (92, 83, 90) |
| phase2 | 1 of 1 | 7 (7) | 0 (0) | 0 (0) | 77675 (77675) | 14 (14) | 375946 (375946) | 30657 (30657) | 349 (349) | 82 (82) |

### Codex, scenario W

| arm | runs with a log | responses | backgrounded results | check_inbox calls | wait polls | weighted cost | input | cache read | cache write | output | wall s |
|---|---:|---|---|---|---|---|---|---|---|---|---|
| baseline | 1 of 1 | 22 (22) | 0 (0) | 0 (0) | 9 (9) | 84617 (84617) | 39282 (39282) | 416000 (416000) | 0 (0) | 747 (747) | 345 (345) |
| phase2 | 1 of 1 | 7 (7) | 0 (0) | 0 (0) | 0 (0) | 44911 (44911) | 32371 (32371) | 107904 (107904) | 0 (0) | 350 (350) | 349 (349) |

### Codex, scenario P

| arm | runs with a log | responses | backgrounded results | check_inbox calls | wait polls | weighted cost | input | cache read | cache write | output | wall s |
|---|---:|---|---|---|---|---|---|---|---|---|---|
| baseline | 0 of 1 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

Run ids: the local `runs/` directory has one directory per row; the row id is the directory name.

## Observed in scenario W, baseline (Claude)

In the baseline the wait for letter `Number: 57` was moved to the background by Claude Code after 120 s, twice per run
(`backgrounded results` 2). The letter was enqueued at 11:21:01 in `baseline-claude-W-1-20261111111803` and at 11:27:48 in
`baseline-claude-W-1-20261111112450`; the agent answered `58` at 11:22:43 and 11:29:31, that is 102 s and 103 s later
(third run `baseline-claude-W-2-20261111113049`: 96 s). The following letters `Number: 73` and `STOP` then reached the agent in
one delivery (the wait result at 11:23:52 and at 11:30:39), and `74` and `report` were sent together. With M1 no wait is moved to the
background and each letter is answered when it arrives (treatment 10, 11, 11 responses against 10, 8, 10 in the baseline); the baseline
agent's late answer merged two letters into one delivery, which is why M1 alone shows no fewer responses in W.

## Rows that never reached a model

| row | outcome | why |
|---|---|---|
| `baseline-claude-W-1-20261111110553` | error `not_found` | no PTY; the launch was held (project MCP question); its run directory was deleted, the row stays |
| `baseline-claude-W-1-20261111111012` | `no-pty` | the launch was held at the project MCP step (the host reads `.mcp.json` files from the copy's folder up to the home folder); the harness now denies that question and keeps the copy outside the home folder |
| `baseline-claude-W-1-20261111111419` | `trust-unexpected` | the Claude trust screen; the screen text was not saved by that harness version |
| `baseline-claude-W-1-20261111111629` | `trust-unexpected` | the trust screen started with the cursor on `No, exit`; the harness did not move it (fixed afterwards) |
| `baseline-codex-P-1-20261111122057` | `start-timeout` | Codex showed `Hooks need review`; `pty.send` answered `blocked` until the 180 s start timeout; saved in `screen.txt` |

The Codex baseline row of scenario W (`baseline-codex-W-1-20261111114132`) was recorded as `time-limit` because the harness missed
the turn end; it was re-parsed from the saved rollout (`completed`, turn end from `task_complete`). The note is in its `problems`.

## Not verified

- n is 3 for each Claude arm of W and for baseline and treatment of P; n is 1 for Claude P phase2 and for each Codex arm. Codex P
  has no run that reached a model.
- The scenarios are designed, not a workload; the letters are fixed and the agent has nothing else to do.
- Only `sonnet` and `gpt-6.1-sol` (effort medium) were run.
- Sessions are fresh and carry about 55k tokens of context; the share of mail turns in long sessions is not measured.
- Codex phase2 run (`phase2-codex-W-1-20261111124533`) ran with the hooks review skipped (`hooksReview: skipped`); the baseline Codex run
  did not show that screen. The effect of skipped hooks on Codex was not measured separately.
- Weights are not provider billing; no provider invoice was read.
- Claude Code (2.1.322) and Codex (0.166.0) versions are those installed on the day; results may differ on other versions.
