import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act, createRef, useState } from "react";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

let dom, server, createRoot, MentionEditor;
const reviewer = {
  id: "reviewer",
  code: "S03",
  role: "Reviewer",
  provider: "claude",
};
before(async () => {
  dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const name of ["window", "document", "Node", "HTMLElement"])
    globalThis[name] = dom.window[name];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ createRoot } = await import("react-dom/client"));
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  ({ MentionEditor } = await server.ssrLoadModule("/src/MentionEditor.jsx"));
});
after(async () => {
  await server?.close();
  dom?.window.close();
});

function placeCaret(node, offset) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
}
async function harness(t) {
  const root = createRoot(document.getElementById("root"));
  const ref = createRef();
  let value;
  function Composer() {
    const [draft, setDraft] = useState("");
    const [query, setQuery] = useState(undefined);
    value = draft;
    return React.createElement(
      "div",
      null,
      React.createElement(MentionEditor, {
        ref,
        value: draft,
        roomId: t.name,
        members: [reviewer],
        onChange: setDraft,
        onQuery: setQuery,
        onKeyDown: () => {},
      }),
      React.createElement(
        "button",
        { onClick: () => ref.current.insertAtSign() },
        "Mention",
      ),
      query !== undefined &&
        React.createElement(
          "button",
          {
            role: "option",
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => ref.current.insertMention(reviewer),
          },
          "Reviewer",
        ),
    );
  }
  await act(async () => root.render(React.createElement(Composer)));
  t.after(async () => {
    await act(async () => root.unmount());
  });
  const editor = document.querySelector("[contenteditable]");
  // jsdom does not natively focus contenteditables as browsers do.
  editor.tabIndex = 0;
  async function fill(text) {
    await act(async () => {
      editor.focus();
      editor.textContent = text;
      placeCaret(editor.firstChild || editor, text.length);
      editor.dispatchEvent(
        new window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
        }),
      );
    });
  }
  return { editor, ref, fill, value: () => value };
}

test("Mention button inserts @ after focus moves out of an empty editor", async (t) => {
  const { editor, value } = await harness(t);
  await act(async () => {
    editor.focus();
    const button = document.querySelector("button");
    button.focus();
    button.click();
  });
  assert.equal(value(), "@");
  assert.equal(editor.textContent, "@");
});

test("Reviewer option replaces a filled query and retains its trailing space", async (t) => {
  const { editor, fill, value } = await harness(t);
  await fill("Please check the launch flow, @");
  await act(async () => document.querySelector('[role="option"]').click());
  assert.equal(value(), "Please check the launch flow, @S03 ");
  assert.equal(
    editor.querySelector(".editor-mention").textContent,
    "@S03 Reviewer",
  );
});

test("sequential native text input retains whitespace and existing text nodes", async (t) => {
  const { editor, value } = await harness(t);
  await act(async () => editor.focus());
  for (const character of "Review this with @S03 ") {
    let inserted;
    await act(async () => {
      const range = window.getSelection().getRangeAt(0);
      range.deleteContents();
      inserted = document.createTextNode(character);
      range.insertNode(inserted);
      range.setStartAfter(inserted);
      range.collapse(true);
      editor.dispatchEvent(
        new window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: character,
        }),
      );
    });
    if (character === " ")
      assert.ok(
        inserted.isConnected,
        "native input must not replace the whitespace node under the browser's caret",
      );
    await act(async () =>
      editor.dispatchEvent(
        new window.KeyboardEvent("keyup", { key: character, bubbles: true }),
      ),
    );
  }
  assert.equal(value(), "Review this with @S03 ");
  assert.equal(
    editor.querySelector(".editor-mention").textContent,
    "@S03 Reviewer",
  );
});

test("menu insertion in the middle preserves following text and Backspace is atomic", async (t) => {
  const { editor, fill, value } = await harness(t);
  await fill("Before @ after");
  await act(async () => {
    placeCaret(editor.firstChild, 8);
    editor.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  });
  await act(async () => document.querySelector('[role="option"]').click());
  assert.equal(value(), "Before @S03  after");
  await act(async () =>
    editor.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
    ),
  );
  assert.equal(value(), "Before  after");
  assert.equal(editor.querySelector(".editor-mention"), null);
});

test("plain text paste preserves spaces, ignores HTML, and recognizes lowercase mentions", async (t) => {
  const { editor, fill, value } = await harness(t);
  await fill("Before after");
  await act(async () => {
    placeCaret(editor.firstChild, 7);
    const paste = new window.Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        getData(type) {
          assert.equal(type, "text/plain");
          return "@s03  <b>plain</b> ";
        },
      },
    });
    editor.dispatchEvent(paste);
  });
  assert.equal(value(), "Before @s03  <b>plain</b> after");
  assert.equal(editor.querySelector("b"), null);
  assert.equal(
    editor.querySelector(".editor-mention").textContent,
    "@S03 Reviewer",
  );
});
