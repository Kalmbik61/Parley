# Qwen questions above the session feedback prompt

Qwen Code 0.27.2 can show an active `AskUserQuestion` and its optional session rating simultaneously. The rating follows the waiting indicator and also handles digits 1–3. A complete, live agent question should use the existing Chat card above the composer.

1. Extend the host Qwen prompt recognizer and its focused tests for the observed optional footer. Match the complete native footer and dialog with their existing status, header, menu, help and waiting guards. Cover Qwen's English and Russian footer strings. Arbitrary or incomplete trailing content should keep the terminal fallback. The rating is separate from the question and must not contribute choices, prompt identity, or a card by itself.
2. On an explicit valid Chat answer only, if necessary dismiss the rating without voting. Recheck the current process, the same question, its redraw and that the footer is gone before using any answer keys. Do not write when the question has changed, the operator is in the terminal's free-text editor, or the timeout expires. Preserve existing answer paths. Cover numeric choice, optional custom input, stale and stalled redraws and confirmation on the real feed path.
3. Replay the reported viewport privately; use synthetic wording for committed tests. Exercise placement in the desktop Chat and verify an answer through an isolated Qwen or host fixture. Keep the live session and installed application running.

## First visible frame

Qwen's blocked status can precede the rendered dialog. The Chat previously mounted a raw terminal panel after 300 ms while the host waited up to one second to read the screen again. For a Qwen question, the first automatic input surface must be the structured card. Preserve explicit access via the Terminal tab for an unsupported question. Continue providing existing sign-in, startup and permission fallbacks where appropriate.

4. Desktop Chat must suppress the automatic terminal panel during Qwen question waits, including a generic blocked signal before the question is classified, delayed feed items and the interval between questions. Avoid increasing a shared timeout. Exercise the delay beyond one second, initial display and disappearance after answering, standard Qwen and Qwen-family providers, and retain unrelated providers' behavior.
5. Prompt the host to read the first completed Qwen dialog as soon as the PTY output redraws. Keep the existing process checks and recovery polling. Check a split status/redraw sequence and stale lifecycle cleanup.
6. Verify the complete Electron transition by observing mounted DOM nodes from before the question, including the terminal panel's first frame. A final-state screenshot alone cannot verify this.
7. Qwen 0.27.2 initially renders the complete question with a temporary right-edge scrollbar. Recognize that viewport on its first redraw, using only the native aligned track or thumb on the dialog, and preserve all content and existing validation. Verify identical options and prompt identity before and after the bar fades and reject malformed menus. Compare the native output and first card in the isolated Electron replay.
