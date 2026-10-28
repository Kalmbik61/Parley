/**
 * Скилл `research-swarm` (спека роя v1, этап 3 брифа r-12): как вести исследовательский рой поверх `create_swarm` и
 * `swarm_add` — когда он нужен и когда нет, нарезка на срезы и швы, формат сдачи (факты только с источником), волна
 * проверки, сводка и закрытие. Опора — процесс волн (`docs/audits/2026-10-23/swarm-waves-process.md`) и итог пилота 1
 * (`docs/audits/2026-10-28/swarm-pilot-result.md`). Четвёртый встроенный скилл: ставится `skill-install.ts` рядом с
 * `parley-browser`.
 *
 * Текст — английский (тексты для агентов — по-английски), до 220 строк. Правила, которые держит хост (кто добавляет
 * участников, автозакрытие, срок жизни, лимиты), скилл пересказывает, а не вводит: тест сверяет имена инструментов.
 */

export const RESEARCH_SWARM_SKILL_NAME = 'research-swarm';

/** Когда подключаться — главным, потому что описания в списке навыков обрезаются; последним — когда не нужен. */
const DESCRIPTION =
  'Run a research swarm in Parley: a queen session splits a big read-only question between drone sessions and ' +
  'verifier sessions and merges one answer with sources. Use it when you consider create_swarm, when you are the queen ' +
  'of a swarm, or when you plan slices for drones: a whole-repository audit, a large document corpus, web research ' +
  'across many sources. A narrow question that fits one context, and any task that writes code, do not need it.';

export const RESEARCH_SWARM_SKILL_MD = `---
name: ${RESEARCH_SWARM_SKILL_NAME}
description: ${JSON.stringify(DESCRIPTION)}
---

# Research swarm

A swarm is a group of Parley sessions for one read-only research question that does not fit one context. The queen splits the question into slices, drones read one slice each, verifiers recheck the claims that go into the answer, and the queen hands in one summary with sources. Nobody in the swarm writes code or files. The human sees the swarm in the sidebar under whoever started it, with a counter and a timer.

## When a swarm pays off

Use a swarm only when all of these hold:
- the question is too big for one context: many independent areas of code, a large set of documents, many external sources;
- it splits into slices that can be read independently, with the links between them (seams) known in advance;
- every claim in the answer can carry a source: \`path:line\` at a known commit, a document and section, or a URL.

Do not use a swarm when:
- the question is about one module or about fifteen files. Pilot 1 measured it: on such a question a swarm of one Opus queen, four Haiku drones and two Sonnet verifiers lost to one Opus agent on coverage (7/8 against 8/8) and on time (9.5 against 6 minutes), and cost more;
- the work writes code, changes files or must agree with someone else's code. Swarm members are read-only;
- the slices cannot be named before the reading starts. Read first yourself, then decide.

When in doubt, answer with one agent. A swarm buys time on a wide question, not tokens.

## Starting a swarm

\`create_swarm\` takes:
- \`tag\`: Research, Audit, Debug or your own short text, up to 24 characters;
- \`objective\`: the queen's whole brief, up to 4096 characters;
- \`provider\`, \`model\`, \`effort\`: the queen's; take them from \`get_map\` with \`field: "providers"\`. The queen merges and judges, so give her a strong model;
- \`role\`: optional, a queen role id from \`list_roles\`.

Parley adds the swarm rules to the queen's brief, so write only the question. A good objective has:
1. The question, split into numbered sub-questions fixed before the run.
2. The subject: the folder or corpus, the commit SHA or document versions, and what is out of scope.
3. What counts as a source, and that a claim without a source is a hypothesis.
4. The output: the answer per sub-question, with sources, hypotheses, "not found" with the scope read, and gaps.
5. Hints for slicing, if you know the seams.

A swarm started by the live lead of a room belongs to the room; one started by any other session belongs to that session. The result comes back to the owner as a letter from Parley: \`Swarm sw-NN [Tag] done, N/M handed in, time\`, the queen's summary and a pointer to her full report. Do not poll the swarm: wait for that letter on your inbox. Only the human can cancel a swarm, from the window.

Limits (the human changes them in Settings → Limits): 16 sessions per swarm with the queen, 8 of them running at once, 6 swarms and 64 swarm sessions per workspace, 90 minutes of lifetime. Swarm sessions do not use the agent new-session limits, but they count toward the workspace limits on concurrent sessions and launches per hour. A refusal names its limit; only the human can raise it.

## The queen's plan

You are the queen when your brief starts with "You are the queen of the research swarm". You do not read the whole subject yourself: you slice, start members, check hand-ins and merge.

1. Read the objective and look over the subject quickly: the folder tree, the table of contents, the list of sources. Write down the base: commit SHA or document versions.
2. Cut the subject into slices. A slice is one bounded piece: a folder or module, a sub-question, a group of documents, one source. One slice — one drone.
3. Name the seams between slices: calls from one slice into another, shared types, config, cross-references. A seam belongs to both sides, so each drone gets it by name with a read budget beyond the slice.
4. Keep a register: slice, drone id, status (planned, running, covered, partial, failed), claims, contradictions, gaps. You hold it in your own context; it is the memory of the swarm.
5. Start the drones with \`swarm_add\`, up to the concurrency limit. Start the verifiers only when the claims are in.

Size: four to eight slices is a good first wave. More slices mean more hand-ins for you to read; your context is the bottleneck.

## Drone task

\`swarm_add\` with \`role: "drone"\` takes \`task\`, \`provider\`, optional \`label\`, \`model\`, \`effort\` and \`agentRole\` (default builtin:researcher, read-only). The task must be self-contained: the drone sees only it and the swarm rules Parley appends. Write it from this template:

\`\`\`
Slice: <folder, module, documents or sources>, at <commit SHA or version>.
Question: <the sub-questions this slice answers>.
Seams: <named links to other slices>; beyond the slice read at most <N> files or pages, and only along these seams.
Out of scope: everything else. Do not draw conclusions about the whole subject.
Hand in with report done, in this format:
COVERAGE: covered | partial | failed — what you read (files, sections, URLs)
FACTS: one claim per line, each with its source (path:line at the SHA, document and section, or URL)
HYPOTHESES: claims you could not tie to a source
NOT FOUND: what you looked for and where
GAPS: what is left unread and why
\`\`\`

Models: cheap models (\`haiku\`, \`sonnet\` on low effort, a small Codex model on low) are fine for bounded slices: find, list, compare, quote. In pilot 1 all four Haiku drones handed in partial coverage, and the queen had to fill the gaps: make slices small enough for the model, or give a stronger model the hard ones.

## Collecting hand-ins

- Wait with \`wait_for\` on a member id, or on "inbox" for Parley's letters. A member that handed in is closed by Parley; you do not close anyone.
- Read a hand-in with \`get_map\` and \`session\` plus \`field: "summary"\`. Read the hand-in, not the transcript.
- Check each hand-in: is coverage stated, do facts carry sources at the right SHA or version, are hypotheses kept apart. A fact without a source goes to the register as a hypothesis.
- Partial or failed coverage is a named gap. Close it with a new drone for the gap, or read it yourself and say so in the summary. Do not wait forever: a member that is stuck or silent becomes a gap.
- Two drones that disagree: both claims go to the verification wave.

"Nothing found" proves nothing on its own. Only the scope read gives it weight, so ask for that scope.

## Verification wave

Every claim that goes into the summary is "not verified" until a verifier who is not its author confirms it.

- Add verifiers with \`swarm_add\` and \`role: "verifier"\` (default builtin:verifier). One verifier takes a batch of claims, grouped by area.
- Prefer another model family or a stronger model than the author's: Haiku claims are checked by Sonnet or a Codex model, and the other way round.
- Each claim goes with its source. The verifier reads the source at the same SHA and answers PASS, FAIL (with the correct fact and its source) or NOT VERIFIED (and why).
- Cheap claims need a cheap check: open the line, grep for the name. Disputed and costly claims get the strong model.
- In pilot 1 the verifiers found and fixed 5 of 88 drone claims. Skip the wave and those errors reach the answer.
- A second round is worth it only if the first one brought a new fact or a new gap. Two rounds without anything new means stop and report what is open.

## Summary

Parley writes you "All members of swarm sw-NN have handed in. Write the summary: call report with the combined result." Then write it:

- the answer per sub-question;
- facts with sources, each marked verified or not verified;
- refuted claims, if they matter for the reader;
- hypotheses, apart from facts;
- gaps and what is not covered, with the reason;
- the cost: members started, how many handed in partial coverage.

Hand it in with \`report\`, status done. Parley passes up to 4096 characters of your summary to the owner and points to your full report. Put the most important findings first.

## Closing

- \`report done\` from the queen closes the swarm. Members still working are closed with it, so do not hand in before the "all members have handed in" letter unless you mean to stop the swarm.
- \`report failed\` closes it as failed. Say what went wrong and what was covered.
- When the lifetime runs out, Parley closes all members and writes you "The time limit of swarm sw-NN has run out". Hand in what you have at once, with what is not covered.
- Only the human cancels a swarm. A member cannot cancel it.

## Errors

| Error | Meaning and what to do |
|---|---|
| \`not-queen\` | Only the queen of a running swarm can call \`swarm_add\`. |
| \`swarm-closed\` | The swarm is done, failed or cancelled: no new members. |
| \`swarm-member\` | Swarm members cannot create sessions, swarms or rooms, or join rooms. Ask the queen through your hand-in. |
| \`swarm-sessions\` | The swarm has reached its size. Merge the remaining slices or cover them yourself. |
| \`swarm-concurrent\` | Too many members are running at once. Wait for one to hand in, then add. |
| \`swarms\`, \`swarm-total\` | The workspace has used its swarms or swarm sessions. Only the human can raise the limit. |
| \`resource-budget\` | The workspace limit on concurrent sessions or launches per hour. Wait, or ask the human. |

## Rules

- Facts only with a source. A claim without one is a hypothesis and is labelled so.
- Members do not talk to each other. Everything goes through the queen and the hand-ins.
- Keep the base fixed. A result read at another SHA or version is checked again or marked stale.
- Members are read-only: no file edits, no commands that change anything, no new sessions.
- Do not start a second swarm for the same question. If the first one failed, take its summary as the input of the next one.
`;
