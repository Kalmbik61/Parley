import test from "node:test";
import assert from "node:assert/strict";
import { tokenizeMentions, mentionedSessions } from "./mentions.js";

const sessions = [
  { id: "backend", code: "S02", role: "Backend", provider: "codex" },
  { id: "review", code: "S03", role: "Review", provider: "claude" },
];

test("known mentions are case insensitive and preserve surrounding text", () => {
  const text = "Ask (@s02), then @S03.\nThanks @S02!";
  const tokens = tokenizeMentions(text, sessions);
  assert.equal(tokens.map((token) => token.text).join(""), text);
  assert.deepEqual(
    tokens.filter((token) => token.session).map((token) => token.session),
    [sessions[0], sessions[1], sessions[0]],
  );
});

test("unknown codes, code prefixes and email addresses remain plain text", () => {
  const text =
    "@S020 @S02suffix @S99 person@S02 @S02@example.com @S02.com x@S03.org @@S02";
  assert.deepEqual(tokenizeMentions(text, sessions), [{ text }]);
});

test("routing deduplicates only exact known mentions in session order", () => {
  assert.deepEqual(
    mentionedSessions("@s03 @S02 @s03 @S020 email@S02", sessions),
    sessions,
  );
  assert.deepEqual(mentionedSessions("@S020 email@S02", sessions), []);
  assert.deepEqual(tokenizeMentions("", sessions), []);
});
