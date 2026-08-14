import { useState } from "react";
import { requestMagicLink, ApiError } from "../api/client";

/**
 * Shows a form to enter an email address and request a sign-in link, then a confirmation message once it's sent.
 */
export default function EmailLoginPage() {
  const [emailName, setEmailName] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const email = `${emailName.trim().toLowerCase()}@scet.ac.in`;

  /**
   * Sends the entered email to the server to request a sign-in link and shows a confirmation or error message.
   */
  async function handleSubmit(e) {
    e.preventDefault();
    if (!emailName.trim() || sending) return;

    setSending(true);
    setError("");
    try {
      await requestMagicLink(email);
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
            We sent a sign-in link to <strong>{email}</strong>. It expires in 15 minutes.
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
          Enter your institute email username and we'll send you a sign-in link.
        </p>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <div className="email-field">
            <input
              className="input email-name-input"
              type="text"
              placeholder="you"
              value={emailName}
              onChange={(e) => setEmailName(e.target.value.replace(/@scet\.ac\.in$/i, "").replace(/@.*$/, ""))}
              autoComplete="username"
            />
            <span className="email-domain">@scet.ac.in</span>
          </div>
          {error && <div className="status-line error">{error}</div>}
          <button type="submit" className="btn" style={{ alignSelf: "flex-start" }} disabled={sending}>
            {sending ? "Sending..." : "Send sign-in link"}
          </button>
        </form>
      </div>
    </div>
  );
}
