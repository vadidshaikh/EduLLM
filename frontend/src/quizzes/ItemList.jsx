import { DIFFICULTY_LABEL, TYPE_LABEL, letter } from "./labels";

/**
 * A set of questions in order. Items with `correct` / `explanation`
 * (faculty view, or a student's once results are out) show the answer.
 * - `picks` ({position: option index as shown}) marks what a student chose:
 *   wrong picks in red, right ones in green (from the answer, or before it's
 *   out from the item's `is_right`).
 *   `pickLabel` tags the chosen option.
 * - `onPick(position, index)` makes the options selectable (answering).
 */
export default function ItemList({ items, showMeta = false, picks, pickLabel = "their answer", onPick }) {
  return (
    <ol className="q-list">
      {items.map((item) => {
        const picked = picks?.[item.position];
        const known = item.correct !== null && item.correct !== undefined;
        return (
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
              <ul className={`q-options${onPick ? " is-answering" : ""}`} role={onPick ? "radiogroup" : undefined}>
                {item.options.map((option, i) => {
                  const classes = [];
                  if (known && item.correct === i) classes.push("is-correct");
                  if (picked === i) {
                    // Before the answer key is out, a student's set still says whether each pick was right.
                    const wrong = known ? item.correct !== i : item.is_right === false;
                    const right = !known && item.is_right === true;
                    classes.push(wrong ? "is-wrong" : right ? "is-correct" : "is-picked");
                  }
                  const body = (
                    <>
                      <span className="q-letter">{letter(i)}</span> {option}
                      {picks && !onPick && picked === i && <span className="q-pick-tag">{pickLabel}</span>}
                    </>
                  );
                  return (
                    <li key={i} className={classes.join(" ") || undefined}>
                      {onPick ? (
                        <button type="button" role="radio" aria-checked={picked === i} onClick={() => onPick(item.position, i)}>
                          {body}
                        </button>
                      ) : (
                        body
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {picks && !onPick && picked == null && item.options.length > 0 && <p className="q-hint">Left blank</p>}
            {item.type !== "mcq" && !showMeta && <p className="q-hint">{TYPE_LABEL[item.type]}</p>}
            {item.explanation && <p className="q-answer">{item.explanation}</p>}
          </li>
        );
      })}
    </ol>
  );
}
