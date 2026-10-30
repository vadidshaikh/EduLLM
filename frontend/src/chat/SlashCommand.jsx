import { useState } from "react";
import Icon from "../ui/Icons";

// Ask's "/" commands (faculty): each opens a form instead of asking the chat.
// `aliases` are other spellings that also run it when sent as the whole message.
export const COMMANDS = [
  { id: "ppt", icon: "slides", name: "Slide deck", sub: "Draft a lecture deck from your docs", aliases: ["ppts", "slides", "deck"] },
  { id: "quiz", icon: "quiz", name: "Quiz", sub: "Write questions and give a classroom a quiz", aliases: ["quizzes"] },
];

// A "/" at the very start of the message, then the command typed so far.
const COMMAND_RE = /^\/([a-z]*)$/i;

/**
 * The command a whole message names ("/ppt", "/Quizzes "), or null.
 */
export function commandFor(text) {
  const match = /^\/([a-z]+)\s*$/i.exec(text.trim());
  if (!match) return null;
  const word = match[1].toLowerCase();
  return COMMANDS.find((c) => c.id === word || c.aliases.includes(word)) ?? null;
}

/**
 * "/" shortcut in the Ask composer: typing "/" at the start of an empty
 * question lists the commands; picking one (click, Enter or Tab) clears the
 * composer and calls `onRun(command)`. Wired like useScopeMention: `sync`
 * on change/select, `handleKeyDown` first in keydown, `menu` in the composer.
 * `enabled` false (students) turns it off.
 */
export function useSlashCommand({ enabled, setQuery, onRun, afterChange }) {
  const [typed, setTyped] = useState(null); // text after "/" while the menu applies
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const options = typed === null ? [] : COMMANDS.filter((c) => [c.id, ...c.aliases].some((w) => w.startsWith(typed.toLowerCase())));
  const open = enabled && typed !== null && !dismissed && options.length > 0;

  function sync(el) {
    const match = COMMAND_RE.exec(el.value);
    if (!match) {
      setTyped(null);
      setDismissed(false);
      return;
    }
    if (match[1] !== typed) setActive(0);
    setTyped(match[1]);
  }

  function run(command) {
    setQuery("");
    setTyped(null);
    requestAnimationFrame(() => afterChange?.());
    onRun(command);
  }

  function handleKeyDown(e) {
    if (!open) return false;
    const n = options.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      run(options[Math.min(active, n - 1)]);
    } else if (e.key === "Escape") {
      setDismissed(true);
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  }

  const menu = open && (
    <div className="ws-pop mention-pop" role="listbox" aria-label="Commands">
      <h4>Create</h4>
      {options.map((c, i) => (
        <button
          type="button"
          key={c.id}
          className="ws-opt"
          role="option"
          aria-selected={i === active}
          // keep focus in the textarea
          onPointerDown={(e) => e.preventDefault()}
          onMouseEnter={() => setActive(i)}
          onClick={() => run(c)}
        >
          <span className={`note-kind cmd-kind${c.id === "ppt" ? " is-slides" : ""}`}>
            <Icon name={c.icon} />
          </span>
          <span>
            <b>
              /{c.id} <span className="cmd-name">{c.name}</span>
            </b>
            <small>{c.sub}</small>
          </span>
        </button>
      ))}
    </div>
  );

  return { sync, handleKeyDown, menu, open, close: () => setTyped(null) };
}
