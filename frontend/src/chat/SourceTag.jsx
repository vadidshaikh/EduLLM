/**
 * Shows a small tag with the title of a source document used in an answer.
 */
export default function SourceTag({ source }) {
  return <span className="source-tag">{source.title}</span>;
}
