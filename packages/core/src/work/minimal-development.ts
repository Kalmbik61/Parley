/** Fixed native asset, loaded by the CLI on demand; never appended to a prompt. */
export const MINIMAL_DEVELOPMENT_NAME = 'minimal-development';

export const MINIMAL_DEVELOPMENT_SKILL_MD = `---
name: minimal-development
description: "Use for implementing, fixing or reviewing code: choose the smallest complete change, reuse existing code and standard platform features, and verify the actual result."
license: MIT
---

# Minimal development

Complete the authorized task with the smallest solution that meets its requirements. This skill applies to the current coding task; it does not change permissions, required behavior or the user's reporting requirements.

## Understand before changing

Read the relevant code and trace the actual flow and callers. For a bug, reproduce the failing behavior and fix its cause at the shared boundary when appropriate. Keep inspection bounded to the evidence needed; expand it when a concrete uncertainty remains.

Before editing, list everything the change must reach: callers, tests, fixtures, configuration and exports. Note what it could break for users, such as data it could lose or expose and callers that would stop working. That list is the scope; features nobody asked for are not.

## Choose the implementation

Use the first option that fully meets the requirements:

1. Reuse an existing implementation or pattern in the project.
2. Use the standard library or a native platform feature.
3. Use an already installed dependency.
4. Write the minimum clear custom code.

Add a dependency, abstraction, configuration option or scaffold only for a demonstrated requirement. Prefer a readable local change over a clever expression. Between options of similar size, take the one that handles edge cases correctly. Keep values in the form the platform or the project already provides instead of converting or wrapping them. Preserve the existing style and other people's changes. Remove redundant code when that completes the task safely.

## Preserve the contract

Keep input validation, authorization, data integrity, useful error handling and accessibility; code you move or merge keeps its own. Do not silently drop requested features, weaken guarantees, truncate a human instruction or substitute a partial implementation. Make a deliberate limitation visible when it materially affects the result. Mark a deliberate shortcut with a known limit by a one-line code comment \`shortcut: <the limit>, <when to replace it>\`, so a search finds every one later. User instructions take priority.

## Verify and report

State brief success criteria for a multi-step task. Run the smallest meaningful check of the changed behavior, using the project's existing tools. A reproduced bug should become a regression check when useful. New non-trivial logic (a branch, a loop, a parser, money or security code, a new script) leaves one small test or self-check; a trivial change needs none. Broaden checks for a concrete unresolved risk or failure; do not repeat passing checks without a new reason.

Report the completed behavior, verification evidence and material limitations concisely. End the final report of a task with one or two lines naming what you skipped or did not check and any risk the user must know. Continue until the authorized task is complete. A short diff or lower token count alone does not establish correctness or savings.

## Context discipline

Search before loading whole files. Reuse stable references and hashes instead of repeating unchanged bodies. Pass agents a bounded task, ownership, acceptance criteria and the relevant evidence. Avoid unnecessary extra agents, repeated broad reviews and automatic rereads on an unchanged wake-up. Do not remove context that is needed to understand or verify the task.
`;

export const MINIMAL_DEVELOPMENT_LICENSE = `MIT License

Copyright (c) 2026 DietrichGebert

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
