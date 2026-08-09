import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { verifyMagicLink, ApiError } from "../api/client";

/**
 * Shows a "signing you in" message while it checks the sign-in link's token, then redirects to the chat page on success or shows an error.
 */
export default function VerifyPage({ auth }) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const attempted = useRef(false);
  const token = searchParams.get("token");

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    verifyMagicLink(token)
      .then((response) => {
        auth.login(response.access_token);
        navigate("/", { replace: true });
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "That sign-in link isn't valid.");
      });
  }, [token, auth, navigate]);

  const displayError = error || (!token ? "Missing sign-in token." : "");

  return (
    <div className="page">
      <div className="login-container">
        <h1>Signing you in</h1>
        {displayError ? (
          <>
            <div className="status-line error">{displayError}</div>
            <Link to="/login">Back to sign in</Link>
          </>
        ) : (
          <p className="dev-note">One moment...</p>
        )}
      </div>
    </div>
  );
}
