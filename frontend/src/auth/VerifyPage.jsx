import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { verifyMagicLink, ApiError } from "../api/client";
import { LoginLayout } from "./EmailLoginPage";

/**
 * Exchanges the sign-in link's token for a session, then goes to Ask; shows an error if the link is bad.
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
    <LoginLayout>
      <div className="login-card">
        <h1>{displayError ? "That link didn't work" : "Signing you in"}</h1>
        {displayError ? (
          <>
            <p className="sub">{displayError} Links work once, for 15 minutes.</p>
            <Link className="link" to="/login">
              Send a new link
            </Link>
          </>
        ) : (
          <p className="sub">One moment...</p>
        )}
      </div>
    </LoginLayout>
  );
}
