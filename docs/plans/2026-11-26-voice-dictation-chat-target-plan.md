# Voice dictation from the Terminal view lands in the chat draft

Date: 2026-11-26. Base: `origin/master`. Human report: in a Qwen session, pressing the toolbar microphone and
finishing dictation puts the transcript into the terminal, not the chat input. Expected: the chat.

## Verified cause

- A session tab shows either Chat or Terminal (`layout/bodies/TerminalBody.tsx`, `effectiveView`).
- In the Terminal view the toolbar microphone targets `terminal:<refKey>` (`TerminalBody.tsx` passes
  `micTargetId` to `ChatToolbar`; `TerminalSurface` registers that target and pastes into xterm / sends via
  `sendWithToast`). The chat composer is not mounted in this view, so no chat target exists.
- In the Chat view the composer microphone targets `chat:<refKey>` and works.
- The global hotkey/palette action resolves the target by focus (`dictation-store.ts#toggleFocused`); that
  behavior is separate and stays unchanged in this plan.

## Task — route the Terminal-view microphone to the chat draft (junior)

Smallest complete change:

1. Register a persistent per-session dictation target `chat-draft:<refKey>` in `TerminalBody` (mounted in both
   views). Its `insert(text)` appends the transcript to the session's chat draft (`useChatUiStore.setDraft`,
   spacing per `voice/insert.ts#joinTranscript`, caret at end) and switches the tab to the Chat view so the
   text is visible where the human expects it. Use the same view-switch action as the toolbar «Chat | Terminal»
   segment. Registration cleanup must not remove a different target instance (mirror `dictation-store#register`).
2. `TerminalBody` toolbar: `micTargetId = chat-draft:<refKey>` for providers with a chat feed; keep
   `terminal:<refKey>` for `kimi` (its native terminal is the input surface). The Chat view and its composer
   microphone are unchanged.
3. Do not change the hotkey focus resolution, the terminal target, or the dictation store semantics.

Files: `packages/desktop/src/renderer/layout/bodies/TerminalBody.tsx`, `packages/desktop/src/renderer/voice/targets.ts`
(or a small sibling), the chat ui-store draft setter, the tab view-switch action; tests beside them.

Acceptance:
- Unit: the draft target appends to a non-empty draft with correct spacing and requests the Chat view; cleanup
  leaves a newer registration intact.
- Component: TerminalBody passes `chat-draft:` for qwen/claude/codex and `terminal:` for kimi.
- Existing dictation/Composer/TerminalSurface suites pass; `pnpm --filter @parley/desktop test` for touched suites.
- Live check in the app: Terminal view of a Qwen session → toolbar mic → dictate → tab shows Chat with the
  transcript in the composer; Send delivers it.

Note: the working tree of the main checkout carries unrelated WIP on `feat/raise-default-limits`; implement
from `origin/master` in a worktree and do not touch that WIP.
