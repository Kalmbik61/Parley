# Fewer mail turns: measurement results

Weighted = input + 0.1 cache read + 1.25 cache write + 5 output (plan weights, not provider billing).

## Scenario P, arm baseline (claude sonnet medium)

Runs: 3, with a log: 3, correct: 3.

| metric | median | values |
|---|---:|---|
| responses | 8 | 9, 8, 8 |
| wait_for | 0 | 0, 0, 0 |
| check_inbox | 2 | 2, 2, 2 |
| backgrounded | 0 | 0, 0, 0 |
| wait polls (Codex) | n/a | n/a |
| yielded cells (Codex) | n/a | n/a |
| input | 20 | 22, 20, 20 |
| cache read | 433716 | 492464, 433716, 432159 |
| cache write | 30314 | 30756, 30300, 30314 |
| output | 361 | 448, 361, 360 |
| weighted | 83072 | 89953, 83072, 82928 |
| wall s | 79 | 79, 80, 79 |

| run | outcome | correct | responses | wall s | problems |
|---:|---|---|---:|---:|---|
| 1 | completed | true | 9 | 79 | - |
| 2 | completed | true | 8 | 80 | - |
| 3 | completed | true | 8 | 79 | - |

## Scenario P, arm baseline (codex gpt-6.1-sol medium)

Runs: 1, with a log: 0, correct: 0. Fewer than 3 runs: no comparison between arms is derived.

| metric | median | values |
|---|---:|---|
| responses | n/a | n/a |
| wait_for | n/a | n/a |
| check_inbox | n/a | n/a |
| backgrounded | n/a | n/a |
| wait polls (Codex) | n/a | n/a |
| yielded cells (Codex) | n/a | n/a |
| input | n/a | n/a |
| cache read | n/a | n/a |
| cache write | n/a | n/a |
| output | n/a | n/a |
| weighted | n/a | n/a |
| wall s | n/a | n/a |

| run | outcome | correct | responses | wall s | problems |
|---:|---|---|---:|---:|---|
| 1 | start-timeout | n/a | n/a | n/a | - |

## Scenario P, arm phase2 (claude sonnet medium)

Runs: 1, with a log: 1, correct: 1. Fewer than 3 runs: no comparison between arms is derived.

| metric | median | values |
|---|---:|---|
| responses | 7 | 7 |
| wait_for | 0 | 0 |
| check_inbox | 0 | 0 |
| backgrounded | 0 | 0 |
| wait polls (Codex) | 0 | 0 |
| yielded cells (Codex) | 0 | 0 |
| input | 14 | 14 |
| cache read | 375946 | 375946 |
| cache write | 30657 | 30657 |
| output | 349 | 349 |
| weighted | 77675 | 77675 |
| wall s | 82 | 82 |

| run | outcome | correct | responses | wall s | problems |
|---:|---|---|---:|---:|---|
| 1 | completed | true | 7 | 82 | - |

## Scenario P, arm treatment (claude sonnet medium)

Runs: 3, with a log: 3, correct: 3.

| metric | median | values |
|---|---:|---|
| responses | 6 | 6, 6, 7 |
| wait_for | 0 | 0, 0, 0 |
| check_inbox | 0 | 0, 0, 0 |
| backgrounded | 0 | 0, 0, 0 |
| wait polls (Codex) | 0 | 0, 0, 0 |
| yielded cells (Codex) | 0 | 0, 0, 0 |
| input | 12 | 12, 12, 14 |
| cache read | 316210 | 316210, 314619, 376376 |
| cache write | 30256 | 30238, 30256, 30737 |
| output | 280 | 268, 280, 374 |
| weighted | 70771 | 70771, 70694, 77943 |
| wall s | 90 | 92, 83, 90 |

| run | outcome | correct | responses | wall s | problems |
|---:|---|---|---:|---:|---|
| 1 | completed | true | 6 | 92 | - |
| 1 | completed | true | 6 | 83 | - |
| 2 | completed | true | 7 | 90 | - |

## Scenario W, arm baseline (claude sonnet medium)

Runs: 7, with a log: 3, correct: 3.

| metric | median | values |
|---|---:|---|
| responses | 10 | 10, 8, 10 |
| wait_for | 5 | 5, 4, 5 |
| check_inbox | 0 | 0, 0, 0 |
| backgrounded | 2 | 2, 2, 2 |
| wait polls (Codex) | n/a | n/a |
| yielded cells (Codex) | n/a | n/a |
| input | 20 | 20, 16, 20 |
| cache read | 553908 | 553908, 438644, 554820 |
| cache write | 32240 | 32150, 32474, 32240 |
| output | 1049 | 1058, 1049, 1046 |
| weighted | 100888 | 100888, 89718, 101032 |
| wall s | 347 | 347, 347, 347 |

| run | outcome | correct | responses | wall s | problems |
|---:|---|---|---:|---:|---|
| 1 | error: {"code":"not_found","message":"no live PTY for session s-01"} | n/a | n/a | n/a | - |
| 1 | no-pty | n/a | n/a | n/a | no live PTY after 90 s; session lifecycle=pending provider=claude queued=null; machine={"live":0,"limit":18,"queued":0,"pressure":"normal","swapGb":11.5,"sleepMinutes":60} queue=0; no host notices |
| 1 | trust-unexpected | n/a | n/a | n/a | - |
| 1 | trust-unexpected | n/a | n/a | n/a | - |
| 1 | completed | true | 10 | 347 | - |
| 1 | completed | true | 8 | 347 | - |
| 2 | completed | true | 10 | 347 | - |

## Scenario W, arm baseline (codex gpt-6.1-sol medium)

Runs: 1, with a log: 1, correct: 1. Fewer than 3 runs: no comparison between arms is derived.

| metric | median | values |
|---|---:|---|
| responses | 22 | 22 |
| wait_for | 4 | 4 |
| check_inbox | 0 | 0 |
| backgrounded | 0 | 0 |
| wait polls (Codex) | 9 | 9 |
| yielded cells (Codex) | 2 | 2 |
| input | 39282 | 39282 |
| cache read | 416000 | 416000 |
| cache write | 0 | 0 |
| output | 747 | 747 |
| weighted | 84617 | 84617 |
| wall s | 345 | 345 |

| run | outcome | correct | responses | wall s | problems |
|---:|---|---|---:|---:|---|
| 1 | completed | true | 22 | 345 | re-parsed from the saved rollout: the harness missed the turn end and recorded time-limit after 900 s; wall time is first task_started to last task_complete |

## Scenario W, arm phase2 (claude sonnet medium)

Runs: 3, with a log: 3, correct: 3.

| metric | median | values |
|---|---:|---|
| responses | 7 | 7, 7, 7 |
| wait_for | 5 | 5, 4, 5 |
| check_inbox | 0 | 0, 0, 0 |
| backgrounded | 0 | 0, 0, 0 |
| wait polls (Codex) | 0 | 0, 0, 0 |
| yielded cells (Codex) | 0 | 0, 0, 0 |
| input | 14 | 14, 14, 14 |
| cache read | 377260 | 376586, 377260, 379064 |
| cache write | 31611 | 31541, 31611, 32085 |
| output | 928 | 866, 928, 968 |
| weighted | 81894 | 81429, 81894, 82867 |
| wall s | 348 | 346, 349, 348 |

| run | outcome | correct | responses | wall s | problems |
|---:|---|---|---:|---:|---|
| 1 | completed | true | 7 | 346 | - |
| 1 | completed | true | 7 | 349 | - |
| 2 | completed | true | 7 | 348 | - |

## Scenario W, arm phase2 (codex gpt-6.1-sol medium)

Runs: 1, with a log: 1, correct: 1. Fewer than 3 runs: no comparison between arms is derived.

| metric | median | values |
|---|---:|---|
| responses | 7 | 7 |
| wait_for | 4 | 4 |
| check_inbox | 0 | 0 |
| backgrounded | 0 | 0 |
| wait polls (Codex) | 0 | 0 |
| yielded cells (Codex) | 0 | 0 |
| input | 32371 | 32371 |
| cache read | 107904 | 107904 |
| cache write | 0 | 0 |
| output | 350 | 350 |
| weighted | 44911 | 44911 |
| wall s | 349 | 349 |

| run | outcome | correct | responses | wall s | problems |
|---:|---|---|---:|---:|---|
| 1 | completed | true | 7 | 349 | - |

## Scenario W, arm treatment (claude sonnet medium)

Runs: 3, with a log: 3, correct: 3.

| metric | median | values |
|---|---:|---|
| responses | 11 | 10, 11, 11 |
| wait_for | 5 | 4, 5, 5 |
| check_inbox | 0 | 0, 0, 0 |
| backgrounded | 0 | 0, 0, 0 |
| wait polls (Codex) | 0 | 0, 0 |
| yielded cells (Codex) | 0 | 0, 0 |
| input | 22 | 20, 22, 22 |
| cache read | 612486 | 551523, 612486, 613700 |
| cache write | 31294 | 30993, 31325, 31294 |
| output | 887 | 798, 887, 913 |
| weighted | 104862 | 97904, 104862, 105075 |
| wall s | 347 | 347, 348, 346 |

| run | outcome | correct | responses | wall s | problems |
|---:|---|---|---:|---:|---|
| 1 | completed | true | 10 | 347 | - |
| 1 | completed | true | 11 | 348 | - |
| 2 | completed | true | 11 | 346 | - |

