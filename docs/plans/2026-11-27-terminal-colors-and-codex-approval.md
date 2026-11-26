# Interactive terminal colors and Codex approval reporting

## Desktop launch environment

In the installed app, Codex's noninteractive launcher environment contained NO_COLOR=1, CODEX_CI=1 and TERM=dumb. The desktop login shell passed NO_COLOR to the host and its interactive children. Repair the desktop environment capture in packages/desktop/src/main/shell-env.ts and its focused tests. Strip the Codex launcher's inherited color suppression before running the login shell and in the skip and failure paths. Preserve deliberate NO_COLOR from the user's login shell or an ordinary launch and preserve unrelated variables. Keep the parent environment intact. Verify that a clean child PTY can render native CLI colors.

## Codex activity

In the reported session the inner git command exited with status 128 while the outer exec result arrived several minutes later. The timer classified elapsed time as an approval without evidence of user input. In packages/host/src/activity/activity-service.ts keep the watchdog diagnostic for overdue calls and unfinished cells, but let the actual provider events determine activity and needs. An elapsed timer must not create a blocked state, approval need, actionable input panel, or an instruction to approve a command. Keep English and Russian diagnostics factual in packages/host/src/host-text.ts. Update focused tests in packages/host/src/activity/activity-terminal.test.ts and any directly dependent assertions. Cover working during a delayed outer result even after an inner command exits, finished turns with a pending cell, normal completion, real terminal approvals and subsequent clearing. Preserve checks performed by Codex itself.
