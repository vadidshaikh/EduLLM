import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ChartBlock from "./ChartBlock";

/**
 * Shown while the answer hasn't started streaming: books tilting off a little shelf.
 */
function Reading() {
  return (
    <div className="reading">
      <span className="mini-shelf">
        {[1, 2, 3, 4].map((k) => (
          <i key={k} style={{ height: `${18 + k * 3}px`, background: `var(--tone-${k})` }} />
        ))}
      </span>
      Reading the docs...
    </div>
  );
}

/**
 * One answer as a page: markdown text (with a cursor while streaming) and
 * any chart. The docs it used are shown on the desk, not here: hovering or
 * clicking the answer (`onHover`, `onSelect`) highlights them there.
 * `active` marks the answer whose docs the desk is highlighting.
 */
export default function AnswerBlock({ message, streaming, active, onSelect, onHover }) {
  if (streaming && !message.content) {
    return (
      <article className="a">
        <Reading />
      </article>
    );
  }

  const usedDocs = message.sources?.length ?? 0;
  const selectable = !streaming && usedDocs > 0;

  return (
    <article
      className={`a${selectable ? " is-selectable" : ""}${active ? " is-active" : ""}`}
      tabIndex={selectable ? 0 : undefined}
      aria-label={selectable ? `Answer that used ${usedDocs} doc${usedDocs === 1 ? "" : "s"}; show them on the desk` : undefined}
      onClick={selectable ? onSelect : undefined}
      onKeyDown={selectable ? (e) => e.key === "Enter" && e.target === e.currentTarget && onSelect() : undefined}
      onMouseEnter={selectable ? () => onHover(true) : undefined}
      onMouseLeave={selectable ? () => onHover(false) : undefined}
    >
      <div className="a-text">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                {children}
              </a>
            ),
          }}
        >
          {message.content}
        </ReactMarkdown>
        {streaming && <span className="cursor" />}
      </div>
      {message.chart && <ChartBlock chart={message.chart} />}
    </article>
  );
}
