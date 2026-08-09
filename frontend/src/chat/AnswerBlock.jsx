import SourceTag from "./SourceTag";
import ChartBlock from "./ChartBlock";

/**
 * Shows one AI answer, including its text, any chart, and the list of source documents it was based on.
 */
export default function AnswerBlock({ message }) {
  return (
    <div className="answer-block">
      <div className="answer-text">{message.content}</div>
      {message.chart && <ChartBlock chart={message.chart} />}
      {message.sources?.length > 0 && (
        <div className="sources-row">
          {message.sources.map((source) => (
            <SourceTag key={source.doc_id} source={source} />
          ))}
        </div>
      )}
    </div>
  );
}
