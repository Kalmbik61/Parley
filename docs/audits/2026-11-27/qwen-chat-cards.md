# Qwen Code 0.27.2: chat answers for multiSelect questions and auto-mode permission dialogs

Date: 2026-11-27. Status: both root causes verified live against the installed `qwen` 0.27.2; fixes verified by unit, integration, live-PTY and Electron runs.

## Symptoms (human report)

1. A Qwen question with several picked options is answered in Chat, Submit shows an error and the
   card closes; in the terminal the picks remain saved but never submitted.
2. With auto approval mode running, tool confirmations can only be answered in the terminal,
   never in Chat.

## Root cause 1 — joined multiSelect answer rejected by the host

The window and the island share one wire format (`answerOf`,
`packages/desktop/src/renderer/lib/question-answer.ts`): picked labels and the «Other» text are
joined with `', '` into `decision.answers[question]`; no sender fills `decision.values`.
`answerQwenPrompt` (`packages/host/src/feed/qwen-prompt.ts`) restored picks only from
`values.choices` or from an answer equal to a single label:

```ts
const values = decision.values?.choices ?? (choices.some(row => row.label === answer) ? [answer!] : []);
```

With two or more picks (or a pick plus «Other») the joined string matches no label, `values` stays
empty and the function returns `false` before writing a single key. `feed.decide` then answers
`{ applied: false, state: 'pending' }`, the window shows the «not applied» note, and the terminal
dialog keeps waiting. Live capture: question «Which toppings?», answer `Nuts, Honey` →
`answerQwenPrompt -> false`, zero writes, dialog still on screen.

Fix: `splitJoinedAnswer` restores the labels from the joined string by longest match (a label
containing `', '` is not split); the unmatched remainder is the «Other» text. Explicit
`values.choices` still win. One host-side change fixes chat, island and Telegram together.

## Root cause 2 — scoped always-allow rows unknown to the recogniser

The native exec/MCP confirmation of qwen 0.27.2 (the dialog auto mode shows when the classifier
blocks a command, and default mode shows for every unallowed command) offers:

```
? Shell touch /tmp/probe/file (…) ←
   touch /tmp/probe/file
 Allow execution of: 'touch'?
 › 1. Yes, allow once
   2. Always allow run 'touch *' commands in this project
   3. Always allow run 'touch *' commands for this user
   4. No, suggest changes (esc)
```

OSC 7501 `state=blocked:kind=permission` arrives, but `permissionKind` knew only
`Yes, allow once`, `Yes, allow always` and `No… (esc)`. An unknown row rejects the whole dialog,
so no card is created and Chat falls back to the live terminal panel. In auto mode edits are
auto-approved, so the remaining confirmations are exactly these exec dialogs — hence «only in the
terminal». Live capture before the fix: `recogniseQwenPrompt(..., 'permission') === null` on the
screen above.

Fix: `permissionKind` also maps `Always allow […] in this project` / `Always allow […] for this
user` and their Russian locale forms (`Всегда разрешать […] в этом проекте` / `… для этого
пользователя`) to `allow_always`. The rule text between prefix and scope suffix is free-form
(`run 'touch *' commands`), so the patterns anchor on the prefix and the scope suffix. The window
already renders each option with its full label, so the scope stays visible; the answer path
sends the row number, which the native list confirms immediately (verified in the qwen source:
`useSelectionList` selects at once when no second digit can extend the number).

## Verification

- Unit: `packages/host/src/feed/qwen-prompt.test.ts` — 51 tests, including joined multiSelect
  (two picks, single pick, pick + Other, Other only, label containing `', '`, explicit values
  priority) and the scoped permission rows in English and Russian, plus a negative test for an
  unknown always-allow wording.
- Integration: `packages/host/src/feed/feed-service-qwen.test.ts` — 33 tests, including
  `feed.decide` with a joined multiSelect answer (writes `1, ' ', 3, ' ', \r`) and the four-row
  shell confirmation (allow row 2 → write `2`).
- Regression: `vitest run src/feed src/pty` — 861 passed; `src/english-text.test.ts` — 3 passed;
  eslint on the changed files clean; `tsc` build of host and desktop clean.
- Live PTY against the installed qwen 0.27.2 (host code driven exactly as `feed-service` drives
  it): multiSelect two picks → applied, dialog gone; multiSelect + Other → applied; single option
  → applied; permission allow → applied, command ran. The four-row dialog above is recognised
  after the fix with kinds `allow_once, allow_always, allow_always, reject_once` and answered.
- Electron (real qwen binary through `PARLEY_QWEN_BIN`, isolated `PARLEY_HOME`, Playwright driving
  the Chat UI): multiSelect card picked and submitted in Chat → state `answered`, agent reply
  «Nuts, Honey»; in auto mode a project ask rule (`Bash(touch *)`) forces the native confirmation,
  the card appears in Chat and «Yes, allow once» applies it (`allowed`, command ran).
  Screenshots: `qwen-chat-cards/electron-1…4.png`. The Electron permission card had two rows
  because the temp project is untrusted by qwen (`showAlwaysAllow` false); the four-row form is
  covered by the live PTY capture and the tests.

## Not verified

- The bordered «Shell Command Execution» box (custom-command confirmation) and an edit dialog
  carrying «Modify with external editor» still fall back to the terminal panel: their shapes are
  outside the `? … ←` recogniser. Left as found; recorded on the backlog.
- Island and Telegram surfaces were not driven live; they share the fixed host path and wire format.