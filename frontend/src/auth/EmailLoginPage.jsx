import { useState } from "react";
import { requestMagicLink, ApiError } from "../api/client";

export default function EmailLoginPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email.trim() || sending) return;

    setSending(true);
    setError("");
    try {
      await requestMagicLink(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div className="page">
        <div className="login-container">
          <h1>Check your email</h1>
          <p className="dev-note">
            We sent a sign-in link to <strong>{email.trim()}</strong>. It expires in 15 minutes.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="login-container">
        <h1>Sign in</h1>
        <p className="dev-note">
          Enter your institute email (<code>@scet.ac.in</code>) and we'll send you a sign-in link.
        </p>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <input
            className="input"
            type="email"
            placeholder="you@scet.ac.in"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {error && <div className="status-line error">{error}</div>}
          <button type="submit" className="btn" style={{ alignSelf: "flex-start" }} disabled={sending}>
            {sending ? "Sending..." : "Send sign-in link"}
          </button>
        </form>
      </div>
    </div>
  );
}
