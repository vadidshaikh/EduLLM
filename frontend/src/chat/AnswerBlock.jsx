import SourceTag from "./SourceTag";
import ChartBlock from "./ChartBlock";

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
