import { useEffect, useState } from "react";
import Icon from "./Icons";
import { spineSize, spineStatus, toneFor } from "./spines";

/**
 * One document drawn as a book spine. `as="button"` makes it clickable;
 * otherwise it's decoration with a hover tooltip (`tip`, default the title).
 * `size` ([w, h]) overrides the derived size; `small` hides the title.
 * `locked` adds the lock tab (in a shared workspace, not published to any classroom).
 * `blank` draws a decorative book: no title and no tooltip.
 */
export function Spine({
  doc,
  as: Tag = "div",
  size,
  scale = 1,
  small = false,
  locked = false,
  blank = false,
  dim = false,
  pulled = false,
  tip,
  onClick,
}) {
  const [w, h] = size ?? spineSize(doc, scale);
  const status = spineStatus(doc);
  const classes = ["spine"];
  if (small) classes.push("is-sm");
  if (locked) classes.push("is-locked");
  if (status) classes.push(`is-${status}`);
  if (dim) classes.push("is-dim");
  if (pulled) classes.push("is-pulled");

  let label = tip ?? doc.title;
  if (!tip && locked) label += ", not published to a classroom";
  if (!tip && status === "indexing") label += `, indexing ${doc.progress ?? 0}%`;
  if (!tip && status === "failed") label += ", indexing failed";

  const attrs =
    Tag === "button" ? { type: "button", "aria-label": label, onClick } : { "aria-hidden": "true" };

  return (
    <Tag
      className={classes.join(" ")}
      data-tone={toneFor(doc.id)}
      data-tip={small || blank ? undefined : label}
      style={{ "--w": `${w}px`, "--h": `${h}px`, "--p": `${doc.progress ?? 0}%` }}
      {...attrs}
    >
      <span className="book">
        {status === "indexing" && <span className="fill" />}
        {!blank && <span className="spine-title">{doc.title}</span>}
        {locked && (
          <span className="lock">
            <Icon name="lock" />
          </span>
        )}
      </span>
    </Tag>
  );
}

/**
 * A run of books standing on a plank, with a labelled tag underneath.
 * `tone` colours the tag's square.
 */
export function ShelfGroup({ label, tone, count, children }) {
  return (
    <div className="sg">
      <div className="sg-books">{children}</div>
      <div className="plank" />
      <div className="sg-tag" style={{ "--tag": tone }}>
        {label}
        {count != null && <small>{count}</small>}
      </div>
    </div>
  );
}

/**
 * The little stack of books that marks a workspace (2 books for shared,
 * 1 for personal, 3 for a classroom or "everything").
 */
export function WsMark({ kind, color }) {
  const count = kind === "personal" ? 1 : kind === "shared" ? 2 : 3;
  return (
    <span className="ws-mark" style={{ "--wc": color }}>
      {Array.from({ length: count }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

/**
 * The floating tooltip for spines (and anything else with `data-tip`).
 * Mounted once by the app shell.
 */
export function SpineTooltip() {
  const [tip, setTip] = useState(null); // {text, left, top}

  useEffect(() => {
    function over(e) {
      const el = e.target instanceof Element ? e.target.closest("[data-tip]") : null;
      if (!el || el.closest(".drawer")) {
        setTip(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setTip({
        text: el.dataset.tip,
        left: Math.min(window.innerWidth - 270, Math.max(8, r.left + r.width / 2 - 60)),
        top: r.top - 46,
      });
    }
    function out(e) {
      if (e.target instanceof Element && e.target.closest("[data-tip]")) setTip(null);
    }
    const hide = () => setTip(null);
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);

  if (!tip) return null;
  return (
    <div className="spine-tip" style={{ left: tip.left, top: tip.top }}>
      {tip.text}
    </div>
  );
}
