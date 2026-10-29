import { useState } from "react";
import { requestMagicLink, ApiError } from "../api/client";
import Logo from "../ui/Logo";
import { Spine } from "../ui/Shelf";

// The sign-in shelf is decoration: classics, not the institute's documents.
const CLASSICS = [
  ["The Prince", "Niccolò Machiavelli"], ["Leviathan", "Thomas Hobbes"], ["The Republic", "Plato"],
  ["Annihilation of Caste", "B. R. Ambedkar"], ["The Communist Manifesto", "Marx and Engels"],
  ["Thus Spoke Zarathustra", "Friedrich Nietzsche"], ["Hind Swaraj", "M. K. Gandhi"],
  ["The Road to Serfdom", "Friedrich Hayek"], ["Arthashastra", "Kautilya"], ["On Liberty", "John Stuart Mill"],
  ["Discipline and Punish", "Michel Foucault"], ["The Social Contract", "Jean-Jacques Rousseau"],
  ["Atlas Shrugged", "Ayn Rand"], ["The Second Sex", "Simone de Beauvoir"], ["Beyond Good and Evil", "Friedrich Nietzsche"],
  ["The Wretched of the Earth", "Frantz Fanon"], ["The Myth of Sisyphus", "Albert Camus"],
  ["Animal Farm", "George Orwell"], ["The Art of War", "Sun Tzu"], ["Meditations", "Marcus Aurelius"],
];

/**
 * The sign-in page and the decorative shelf beside it. Pages that aren't
 * the sign-in form itself (e.g. verifying a link) pass their own card.
 */
export function LoginLayout({ children }) {
  return (
    <div className="login">
      <section className="login-form-side">
        <span>
          <Logo />
        </span>
        {children}
      </section>
      <section className="login-shelf-side" aria-hidden="true">
        <h2>
          Every circular, calendar and report. One <span className="lean">shelf.</span>
        </h2>
        <div>
          <div className="shelf-row">
            {CLASSICS.map(([title, author], i) => (
              <Spine key={title} doc={{ id: `classic-${i}`, title }} scale={1.15} tip={`${title}, ${author}`} />
            ))}
          </div>
          <div className="plank" />
        </div>
        <p className="note">
          Ask in plain words. EduLLM pulls the right docs off the shelf and shows you which ones it read.
        </p>
      </section>
    </div>
  );
}

/**
 * Asks for an institute email and sends a sign-in link to it. Typing a full
 * address with another domain sends it as is (for DEV_FACULTY_EMAILS); the
 * backend decides whether it's allowed.
 */
export default function EmailLoginPage() {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const typed = value.trim().toLowerCase();
  const email = typed.includes("@") ? typed : `${typed}@scet.ac.in`;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!typed || sending) return;
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

  return (
    <LoginLayout>
      {sent ? (
        <div className="login-card">
          <h1>Check your inbox</h1>
          <p className="sub">
            We sent a link to <b>{email}</b>. It works once, for 15 minutes.
          </p>
          <button className="link" type="button" style={{ alignSelf: "flex-start" }} onClick={() => setSent(false)}>
            Use a different email
          </button>
        </div>
      ) : (
        <div className="login-card">
          <h1>Sign in</h1>
          <p className="sub">Use your SCET email. We&apos;ll send you a sign-in link, no password needed.</p>
          <form onSubmit={handleSubmit} noValidate>
            <label className="field-label" htmlFor="email-name">
              Institute email
            </label>
            <div className="email">
              <input
                id="email-name"
                autoComplete="username"
                placeholder="your.name"
                value={value}
                onChange={(e) => setValue(e.target.value.replace(/@scet\.ac\.in$/i, ""))}
              />
              {!typed.includes("@") && <span>@scet.ac.in</span>}
            </div>
            {error && <p className="form-error">{error}</p>}
            <button className="btn" type="submit" disabled={sending} style={{ width: "100%", marginTop: ".9rem" }}>
              {sending ? "Sending..." : "Email me a sign-in link"}
            </button>
          </form>
          <p className="login-foot">
            Students see the docs published to their classrooms. Faculty work in personal and shared workspaces and
            manage their libraries.
          </p>
        </div>
      )}
    </LoginLayout>
  );
}
