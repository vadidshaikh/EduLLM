import SourceTag from "./SourceTag";
import ChartBlock from "./ChartBlock";

export default function AnswerBlock({ result }) {
  return (
    <div className="answer-block">
      <div className="answer-text">{result.answer}</div>
      {result.chart && <ChartBlock chart={result.chart} />}
      {result.sources?.length > 0 && (
        <div className="sources-row">
          {result.sources.map((source) => (
            <SourceTag key={source.doc_id} source={source} />
          ))}
        </div>
      )}
    </div>
  );
}
