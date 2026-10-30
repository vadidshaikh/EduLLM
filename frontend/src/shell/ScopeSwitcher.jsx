import { useEffect, useRef, useState } from "react";
import { ApiError, joinClassroom, leaveClassroom } from "../api/client";
import Icon from "../ui/Icons";
import { WsMark } from "../ui/Shelf";
import { confirmDialog } from "../ui/confirm";

/**
 * The topbar's shelf switcher: a button showing the current shelf, opening
 * a menu of `sections` ({heading, options: [{id, kind, color, name, sub}]}).
 * Its footer offers "New shared workspace" (faculty, opens `onNewWorkspace`)
 * or joining a classroom by code (students).
 */
export default function ScopeSwitcher({ auth, sections, selected, onSelect, onChanged, onNewWorkspace }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!selected) return <div className="scope-wrap" />;

  function choose(id) {
    onSelect(id);
    setOpen(false);
  }

  return (
    <div className="scope-wrap" ref={wrapRef}>
      <button
        className="scope-switch"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Current shelf: ${selected.name}. Change`}
        onClick={() => setOpen(!open)}
      >
        <WsMark kind={selected.kind} color={selected.color} />
        <span>
          <b>{selected.name}</b>
          <small>{selected.sub}</small>
        </span>
        <Icon name="chev" />
      </button>
      {open && (
        <div className="ws-pop" role="menu">
          {sections.map(
            (section, i) =>
              section.options.length > 0 && (
                <div key={section.heading ?? i}>
                  {section.heading && <h4>{section.heading}</h4>}
                  {section.options.map((o) => (
                    <div className="ws-opt-row" key={o.id ?? "all"}>
                      <button
                        className="ws-opt"
                        role="menuitemradio"
                        aria-checked={o.id === selected.id}
                        onClick={() => choose(o.id)}
                      >
                        <WsMark kind={o.kind} color={o.color} />
                        <span>
                          <b>{o.name}</b>
                          <small>{o.sub}</small>
                        </span>
                      </button>
                      {o.kind === "class" && (
                        <LeaveButton auth={auth} classroom={o} onLeft={() => { onChanged(); if (o.id === selected.id) onSelect(null); }} />
                      )}
                    </div>
                  ))}
                </div>
              )
          )}
          {auth.role === "faculty" && (
            <div className="ws-foot">
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => {
                  setOpen(false);
                  onNewWorkspace();
                }}
              >
                <Icon name="plus" /> New shared workspace
              </button>
            </div>
          )}
          {auth.role === "student" && (
            <JoinForm
              auth={auth}
              onJoined={async (id) => {
                await onChanged();
                choose(id);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Leaves a classroom (students), after confirming.
 */
function LeaveButton({ auth, classroom, onLeft }) {
  async function leave() {
    const ok = await confirmDialog({
      title: `Leave ${classroom.name}?`,
      message: "You'll stop seeing its docs. You can rejoin with its code.",
      confirmLabel: "Leave",
      danger: true,
    });
    if (!ok) return;
    try {
      await leaveClassroom(auth.token, classroom.id);
      onLeft();
    } catch {
      // stays in the list; nothing else to show in a menu
    }
  }
  return (
    <button className="icon-btn ws-leave" title={`Leave ${classroom.name}`} aria-label={`Leave ${classroom.name}`} onClick={leave}>
      <Icon name="x" />
    </button>
  );
}

/**
 * Students: join a classroom with the code their teacher shared.
 */
function JoinForm({ auth, onJoined }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const joined = await joinClassroom(auth.token, code);
      setCode("");
      await onJoined(joined.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't join that classroom.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="ws-foot" onSubmit={submit}>
        <label className="sr" htmlFor="join-code">
          Classroom code
        </label>
        <input
          className="input"
          id="join-code"
          placeholder="Classroom code, e.g. P4D8WE"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <button className="btn" type="submit" disabled={busy || !code.trim()}>
          Join
        </button>
      </form>
      {error && <p className="ws-err">{error}</p>}
    </>
  );
}
