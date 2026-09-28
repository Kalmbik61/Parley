import React, {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { tokenizeMentions } from "./mentions.js";

// App keys the editor by room. Retain only recent caret bookmarks across remounts.
const roomCarets = new Map();

function textOf(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node.nodeType === Node.ELEMENT_NODE && node.dataset?.mentionCode)
    return node.dataset.mentionText || `@${node.dataset.mentionCode}`;
  if (node.nodeName === "BR") return "\n";
  return [...node.childNodes].map(textOf).join("");
}

function pointAt(root, offset) {
  let remaining = offset;
  function visit(parent) {
    for (let i = 0; i < parent.childNodes.length; i++) {
      const node = parent.childNodes[i],
        length = textOf(node).length;
      if (remaining <= length) {
        if (node.nodeType === Node.TEXT_NODE)
          return [node, Math.min(remaining, length)];
        if (node.dataset?.mentionCode || node.nodeName === "BR")
          return [parent, i + (remaining > 0 ? 1 : 0)];
        return visit(node);
      }
      remaining -= length;
    }
    return [parent, parent.childNodes.length];
  }
  return visit(root);
}

function chip(session, text = `@${session.code}`) {
  const span = document.createElement("span");
  span.className = `editor-mention ${session.provider}`;
  span.contentEditable = "false";
  span.dataset.mentionCode = session.code;
  span.dataset.mentionId = session.id;
  span.dataset.mentionText = text;
  span.textContent = `@${session.code} ${session.role}`;
  span.title = `Mention ${session.role} · ${session.provider === "codex" ? "Codex" : "Claude Code"}`;
  return span;
}

export const MentionEditor = forwardRef(function MentionEditor(
  {
    value,
    roomId,
    members,
    onChange,
    onQuery,
    onKeyDown,
    "aria-controls": controls,
    "aria-activedescendant": activeDescendant,
  },
  ref,
) {
  const root = useRef(null),
    lastValue = useRef(null),
    savedRange = useRef(null),
    queryRange = useRef(null),
    lastContext = useRef(null);
  const signature = members
    .map((s) => `${s.id}:${s.code}:${s.role}:${s.provider}`)
    .join("|");
  function currentRange() {
    const selection = window.getSelection();
    if (
      selection?.rangeCount &&
      root.current.contains(selection.anchorNode) &&
      root.current.contains(selection.focusNode)
    )
      return selection.getRangeAt(0);
    if (
      savedRange.current &&
      root.current.contains(savedRange.current.startContainer)
    )
      return savedRange.current;
    const range = document.createRange();
    range.selectNodeContents(root.current);
    range.collapse(false);
    return range;
  }
  function offsets(range) {
    const before = range.cloneRange();
    before.selectNodeContents(root.current);
    before.setEnd(range.startContainer, range.startOffset);
    const start = textOf(before.cloneContents()).length;
    before.setEnd(range.endContainer, range.endOffset);
    return { start, end: textOf(before.cloneContents()).length };
  }
  function rangeAt(bookmark) {
    const range = document.createRange();
    range.setStart(...pointAt(root.current, bookmark.start));
    range.setEnd(...pointAt(root.current, bookmark.end));
    return range;
  }
  function render(text) {
    root.current.replaceChildren(
      ...tokenizeMentions(text, members).map((token) =>
        token.session
          ? chip(token.session, token.text)
          : document.createTextNode(token.text),
      ),
    );
  }
  function saveCaret(range) {
    savedRange.current = range.cloneRange();
    roomCarets.delete(roomId);
    roomCarets.set(roomId, { value: textOf(root.current), ...offsets(range) });
    if (roomCarets.size > 50) roomCarets.delete(roomCarets.keys().next().value);
  }
  function remember() {
    const range = currentRange();
    saveCaret(range);
    const before = range.cloneRange();
    before.selectNodeContents(root.current);
    before.setEnd(range.startContainer, range.startOffset);
    const prefix = textOf(before.cloneContents()),
      match = prefix.match(/(?:^|[\s([{])@([^\s@]*)$/);
    queryRange.current = match
      ? { start: prefix.length - match[1].length - 1, end: prefix.length }
      : null;
    onQuery(match ? match[1] : undefined);
  }
  function emit() {
    const next = textOf(root.current);
    lastValue.current = next;
    onChange(next);
    remember();
  }
  function normalizeMentions() {
    const text = textOf(root.current);
    const mentions = tokenizeMentions(text, members).filter(
      (token) => token.session,
    );
    const chips = [...root.current.querySelectorAll("[data-mention-code]")];
    if (
      mentions.length === chips.length &&
      mentions.every(
        (token, i) =>
          chips[i].dataset.mentionText === token.text &&
          chips[i].dataset.mentionId === token.session.id,
      )
    )
      return;
    const bookmark = offsets(currentRange());
    render(text);
    select(rangeAt(bookmark));
  }
  function select(range) {
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    savedRange.current = range.cloneRange();
  }
  function insertText(text) {
    const range = currentRange();
    root.current.focus();
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    select(range);
    normalizeMentions();
    emit();
  }
  useImperativeHandle(ref, () => ({
    focus: () => {
      const range = currentRange();
      root.current.focus();
      select(range);
    },
    insertAtSign: () => {
      const range = currentRange(),
        before = range.cloneRange();
      before.selectNodeContents(root.current);
      before.setEnd(range.startContainer, range.startOffset);
      const prefix = textOf(before.cloneContents());
      insertText(`${prefix && !/\s$/.test(prefix) ? " " : ""}@`);
    },
    insertMention: (session) => {
      const range = currentRange();
      root.current.focus();
      if (queryRange.current) {
        const start = pointAt(root.current, queryRange.current.start),
          end = pointAt(root.current, queryRange.current.end);
        range.setStart(...start);
        range.setEnd(...end);
      }
      range.deleteContents();
      const token = chip(session),
        space = document.createTextNode(" "),
        fragment = document.createDocumentFragment();
      fragment.append(token, space);
      range.insertNode(fragment);
      range.setStart(space, space.length);
      range.collapse(true);
      select(range);
      emit();
    },
  }));
  useLayoutEffect(() => {
    const context = `${roomId}:${signature}`;
    if (value === lastValue.current && context === lastContext.current) return;
    const bookmark = roomCarets.get(roomId);
    render(value);
    lastValue.current = value;
    lastContext.current = context;
    savedRange.current = rangeAt(
      bookmark?.value === value
        ? bookmark
        : { start: value.length, end: value.length },
    );
    if (document.activeElement === root.current) select(savedRange.current);
    queryRange.current = null;
    onQuery(undefined);
  }, [value, roomId, signature]);
  function keydown(event) {
    if (event.nativeEvent.isComposing) return;
    onKeyDown(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter") {
      event.preventDefault();
      insertText("\n");
      return;
    }
    if (event.key === "Backspace") {
      const range = currentRange();
      if (!range.collapsed) return;
      const node = range.startContainer,
        offset = range.startOffset;
      const previous =
        node.nodeType === Node.TEXT_NODE &&
        (offset === 0 || (offset === 1 && node.textContent[0] === " "))
          ? node.previousSibling
          : node === root.current
            ? node.childNodes[offset - 1]
            : null;
      if (previous?.dataset?.mentionCode) {
        event.preventDefault();
        if (node.nodeType === Node.TEXT_NODE && offset === 1)
          node.deleteData(0, 1);
        previous.remove();
        emit();
      }
    }
  }
  return (
    <div
      ref={root}
      className="mention-editor"
      role="textbox"
      aria-label="Message to room"
      aria-multiline="true"
      aria-autocomplete="list"
      aria-controls={controls}
      aria-activedescendant={activeDescendant}
      contentEditable
      suppressContentEditableWarning
      data-placeholder="Share a thought, ask a question… @ to mention"
      onInput={emit}
      onCompositionEnd={emit}
      onKeyDown={keydown}
      onKeyUp={(event) => {
        if (event.nativeEvent.isComposing) return;
        // Let native input finish before converting completed mentions to chips.
        // Ordinary typing (especially spaces) must retain its native text nodes.
        if (event.key.length === 1 && /[\s.,:;!?)\]}]/.test(event.key))
          normalizeMentions();
        if (event.key !== "Escape") remember();
      }}
      onClick={remember}
      onMouseUp={remember}
      onFocus={() => {
        if (savedRange.current) select(savedRange.current);
      }}
      onBlur={() => {
        saveCaret(currentRange());
      }}
      onPaste={(event) => {
        event.preventDefault();
        insertText(event.clipboardData.getData("text/plain"));
      }}
    />
  );
});
