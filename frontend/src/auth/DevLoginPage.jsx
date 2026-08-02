// DEV ONLY — replace with a real SSO redirect once the auth service exists.
// Pastes a JWT minted via `backend/scripts/mint_dev_token.py` and stores it
// client-side. The role shown here is decoded for display only; the backend
// re-verifies the token's signature and claims on every request.
import { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function DevLoginPage({ auth }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  function handleSubmit(e) {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;

    try {
      const [, payload] = token.split(".");
      JSON.parse(atob(payload));
    } catch {
      setError("That doesn't look like a valid JWT.");
      return;
    }

    setError("");
    auth.login(token);
    navigate("/");
  }

  return (
    <div className="page">
      <div className="login-container">
        <h1>Sign in</h1>
        <p className="dev-note">
          Dev-only login. Mint a token with{" "}
          <code>python backend/scripts/mint_dev_token.py --sub you@college.edu --role student</code>{" "}
          and paste it below.
        </p>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <textarea
            className="textarea input"
            rows={4}
            placeholder="Paste JWT here"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {error && <div className="status-line error">{error}</div>}
          <button type="submit" className="btn" style={{ alignSelf: "flex-start" }}>
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}
