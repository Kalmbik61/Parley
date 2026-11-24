# Shared `ps` poll, measured

Plan: `docs/plans/2026-11-09-session-shell-processes-plan.md`, stage D.

**What was measured.** Ten runs of the real `ps` with the exact arguments and environment the host monitor uses
(`ps -axo pid,ppid,%cpu,%mem,rss,etime,ucomm`, `LC_ALL=C`), no stub. Each run is the wall time from `spawn` to the
`close` event with the whole output collected, taken with `performance.now()`. Parsing and tree walking are not
included. Script: a ten-iteration loop around `child_process.spawn`, run once on an otherwise normal working
machine while Parley and other tools were running.

**Machine.** Apple M4 Pro, macOS 27.2.

| Metric | Value |
| --- | --- |
| Runs | 10 |
| Median | 21.8 ms |
| Maximum | 25.3 ms |
| Minimum | 20.3 ms |
| `ps` rows per run | 993 (all ten runs) |

Per-run times, ms: 25.3, 22.2, 22.3, 21.7, 20.3, 21.6, 21.2, 22.0, 21.8, 21.1.

**How to read it.** This is one machine on one afternoon, not a guarantee. It says only that one shared poll with
about a thousand processes took tens of milliseconds here, once every 2 seconds while a session list is open and
subscribed. It was not measured under heavy load, on Linux, or with the window rendering the list.
The earlier exploratory figure in the plan (66–88 ms at about 880 processes, three runs) was taken on a different
day and load; the two are not comparable and neither is a performance criterion.

## Check with real agents

**What was run.** The monitor's source at this stage, bundled outside the repository, with the real `ps` and real PTY
roots under the running Parley host: one Claude session and one new Codex session (`gpt-6-luna`), sampled once a second
for 171 s. Each agent ran `sleep` alone, `sleep | cat`, and a `sleep` with `argv[0]` replaced by
`fake --token=SECRET-PROBE`.

| Metric | Value |
| --- | --- |
| Polls, including parsing and tree walking | 162 |
| Median | 25 ms |
| Maximum | 97 ms |
| `ps` rows at the end | 988 |
| Snapshots delivered | 323 |
| Snapshots containing `SECRET-PROBE`, `fake` or `/` | 0 |

**Claude.** `zsh, sleep, cat` appeared and left for the pipeline, and `zsh, sleep` for the renamed process. The other
rows were the check's own `zsh`, `node` and `ps`.

**Codex.** The list ended empty and was marked approximate throughout. `sleep` appeared alone, `zsh, sleep, cat` for the
pipeline, and `sleep` for the renamed process, and each left when its command ended. False rows seen, all known
limitations of the Codex classifier:

- `git`, `git-remote-http` from Codex startup, for 68 s in this run and 39 s in the earlier probe;
- `zsh`, `tail`, `printf` for about a second at startup;
- `sandbox-exec` for about a second before a command.

**On all live PTYs.** An earlier one-shot run over 16 real PTY roots gave an empty list for 13 idle sessions (7 Codex, 6
Claude), and the commands in progress for the other 3. These 13 would each have shown false rows before the classifier
was replaced.

This is one machine on one day and does not cover Linux or a window rendering the list.
