import { useState } from "react";
import { queryLLM, ApiError } from "../api/client";
import RoleBadge from "./RoleBadge";
import AnswerBlock from "./AnswerBlock";

export default function ChatPage({ auth }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!query.trim() || loading) return;

    setLoading(true);
    setError("");
    try {
      const response = await queryLLM(auth.token, query.trim());
      setResult(response);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <div className="chat-container">
        <div className="chat-header">
          <RoleBadge role={auth.role} />
          <h1 style={{ margin: 0, fontSize: "1.3rem" }}>Ask about your institute's documents</h1>
        </div>

        <form className="query-form" onSubmit={handleSubmit}>
          <textarea
            className="textarea input"
            rows={2}
            placeholder="Ask a question..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn" type="submit" disabled={loading}>
            {loading ? "Asking..." : "Ask"}
          </button>
        </form>

        {error && <div className="status-line error">{error}</div>}
        {result && <AnswerBlock result={result} />}
      </div>
    </div>
  );
}
