---
name: minimal-development
description: "Use for implementing, fixing or reviewing code: choose the smallest complete change, reuse existing code and standard platform features, and verify the actual result."
license: MIT
---

# Minimal development

Complete the authorized task with the smallest solution that meets its requirements. This skill applies to the current coding task; it does not change permissions, required behavior or the user's reporting requirements.

## Understand before changing

Read the relevant code and trace the actual flow and callers. For a bug, reproduce the failing behavior and fix its cause at the shared boundary when appropriate. Keep inspection bounded to the evidence needed; expand it when a concrete uncertainty remains.

## Choose the implementation

Use the first option that fully meets the requirements:

1. Reuse an existing implementation or pattern in the project.
2. Use the standard library or a native platform feature.
3. Use an already installed dependency.
4. Write the minimum clear custom code.

Add a dependency, abstraction, configuration option or scaffold only for a demonstrated requirement. Prefer a readable local change over a clever expression. Preserve the existing style and other people's changes. Remove redundant code when that completes the task safely.

## Preserve the contract

Keep input validation, authorization, data integrity, useful error handling and accessibility. Do not silently drop requested features, weaken guarantees, truncate a human instruction or substitute a partial implementation. Make a deliberate limitation visible when it materially affects the result. User instructions take priority.

## Verify and report

State brief success criteria for a multi-step task. Run the smallest meaningful check of the changed behavior, using the project's existing tools. A reproduced bug should become a regression check when useful. Broaden checks for a concrete unresolved risk or failure; do not repeat passing checks without a new reason.

Report the completed behavior, verification evidence and material limitations concisely. Continue until the authorized task is complete. A short diff or lower token count alone does not establish correctness or savings.

## Context discipline

Search before loading whole files. Reuse stable references and hashes instead of repeating unchanged bodies. Pass agents a bounded task, ownership, acceptance criteria and the relevant evidence. Avoid unnecessary extra agents, repeated broad reviews and automatic rereads on an unchanged wake-up. Do not remove context that is needed to understand or verify the task.
