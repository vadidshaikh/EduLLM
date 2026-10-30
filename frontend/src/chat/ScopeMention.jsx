import { useState } from "react";
import { WsMark } from "../ui/Shelf";

// "@" at the start of the text or after a space, then the name typed so far
// (spaces allowed, since names have them), up to the caret.
const MENTION_RE = /(?:^|\s)@([^@\n]{0,40})$/;
const MAX_OPTIONS = 8;

/**
 * Options whose name contains `text`, names starting with it first. Empty
 * text lists everything.
 */
function matching(sections, text) {
  const q = text.trim().toLowerCase();
  const scored = [];
  for (const section of sections) {
    for (const option of section.options) {
      const name = option.name.toLowerCase();
      const at = q ? name.indexOf(q) : 0;
      if (at === -1) continue;
      const wordStart = at === 0 || name[at - 1] === " ";
      scored.push({ option, rank: at === 0 ? 0 : wordStart ? 1 : 2 });
    }
  }
  return scored.sort((a, b) => a.rank - b.rank).slice(0, MAX_OPTIONS);
}

/**
 * "@" shortcut in the Ask composer: typing "@" then part of a workspace,
 * classroom or library name lists the switcher's matching shelves; picking
 * one (click, Enter or Tab) removes the "@name" from the question and makes
 * that shelf the one Ask searches, same as choosing it in the switcher.
 *
 * Wire `sync` to the textarea's change and select events and call
 * `handleKeyDown` first in its keydown handler (it returns true when it
 * used the key). `menu` is the popup, to render inside the composer.
 */
export function useScopeMention({ sections, textareaRef, setQuery, onPick, afterChange }) {
  const [mention, setMention] = useState(null); // {start, end, text}
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState(null); // start of a mention closed with Escape

  const options = mention ? matching(sections, mention.text) : [];
  const open = mention !== null && mention.start !== dismissedAt && options.length > 0;

  function sync(el) {
    const caret = el.selectionStart;
    if (caret !== el.selectionEnd) return setMention(null);
    const match = MENTION_RE.exec(el.value.slice(0, caret));
    if (!match) {
      setMention(null);
      setDismissedAt(null);
      return;
    }
    const next = { start: caret - match[1].length - 1, end: caret, text: match[1] };
    if (!mention || mention.text !== next.text || mention.start !== next.start) setActive(0);
    setMention(next);
  }

  function pick(option) {
    const el = textareaRef.current;
    const before = el.value.slice(0, mention.start);
    const after = el.value.slice(mention.end);
    // don't leave a double space where "@name" was
    const joined = before.endsWith(" ") && after.startsWith(" ") ? before + after.slice(1) : before + after;
    setQuery(joined);
    setMention(null);
    onPick(option.id);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
      afterChange?.();
    });
  }

  function handleKeyDown(e) {
    if (!open) return false;
    const n = options.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      pick(options[Math.min(active, n - 1)].option);
    } else if (e.key === "Escape") {
      setDismissedAt(mention.start);
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  }

  const menu = open && (
    <div className="ws-pop mention-pop" role="listbox" aria-label="Ask in">
      <h4>Ask in</h4>
      {options.map(({ option }, i) => (
        <button
          type="button"
          key={option.id ?? "all"}
          className="ws-opt"
          role="option"
          aria-selected={i === active}
          // keep focus (and the caret) in the textarea
          onPointerDown={(e) => e.preventDefault()}
          onMouseEnter={() => setActive(i)}
          onClick={() => pick(option)}
        >
          <WsMark kind={option.kind} color={option.color} />
          <span>
            <b>{option.name}</b>
            <small>{option.sub}</small>
          </span>
        </button>
      ))}
    </div>
  );

  return { sync, handleKeyDown, menu, open, close: () => setMention(null) };
}
