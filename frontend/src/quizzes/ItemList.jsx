import { DIFFICULTY_LABEL, TYPE_LABEL, letter } from "./labels";

/**
 * A set of questions in order. Items with `correct` / `explanation`
 * (faculty view) show the answer; students' items don't have them.
 */
export default function ItemList({ items, showMeta = false }) {
  return (
    <ol className="q-list">
      {items.map((item) => (
        <li key={item.position} className="q-item">
          <div className="q-head">
            <span className="q-num">{item.position}.</span>
            <p className="q-text">{item.prompt}</p>
          </div>
          {showMeta && (
            <small className="note-sub q-meta">
              {TYPE_LABEL[item.type]}, {DIFFICULTY_LABEL[item.difficulty]}, {item.topic}
            </small>
          )}
          {item.options.length > 0 && (
            <ul className="q-options">
              {item.options.map((option, i) => (
                <li key={i} className={item.correct === i ? "is-correct" : undefined}>
                  <span className="q-letter">{letter(i)}</span> {option}
                </li>
              ))}
            </ul>
          )}
          {item.type !== "mcq" && !showMeta && <p className="q-hint">{TYPE_LABEL[item.type]}</p>}
          {item.explanation && <p className="q-answer">{item.explanation}</p>}
        </li>
      ))}
    </ol>
  );
}
