import { useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./auth/useAuth";
import { useTheme } from "./ThemeContext";
import EmailLoginPage from "./auth/EmailLoginPage";
import VerifyPage from "./auth/VerifyPage";
import ChatPage from "./chat/ChatPage";
import LibraryPage from "./library/LibraryPage";
import ScopeSwitcher from "./shell/ScopeSwitcher";
import Notices from "./shell/Notices";
import NewWorkspaceDialog from "./shell/NewWorkspaceDialog";
import { useShelves } from "./shell/useShelves";
import Icon from "./ui/Icons";
import Logo from "./ui/Logo";
import { SpineTooltip } from "./ui/Shelf";
import { nameFromEmail } from "./ui/spines";

/**
 * Signed out: only the sign-in and link-verification pages. Signed in: the app shell.
 */
export default function App() {
  const auth = useAuth();

  if (!auth.isAuthenticated) {
    return (
      <>
        <Routes>
          <Route path="/login" element={<EmailLoginPage />} />
          <Route path="/auth/verify" element={<VerifyPage auth={auth} />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        <SpineTooltip />
      </>
    );
  }

  return (
    <Routes>
      <Route path="/auth/verify" element={<VerifyPage auth={auth} />} />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="*" element={<AppShell auth={auth} />} />
    </Routes>
  );
}

/**
 * Top bar (shelf switcher, Ask / Library, notices, theme, who's signed in)
 * over the current view. The switcher's one choice drives both views: what
 * Ask searches and which library the Library view shows (faculty).
 */
function AppShell({ auth }) {
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const shelves = useShelves(auth);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [creating, setCreating] = useState(false); // the "New shared workspace" dialog
  const navigate = useNavigate();
  const isFaculty = auth.role === "faculty";
  const view = isFaculty && location.pathname.startsWith("/library") ? "library" : "ask";
  const name = nameFromEmail(auth.sub);
  const roleLine = isFaculty
    ? "Faculty"
    : ["Student", auth.claims?.dept?.toUpperCase()].filter(Boolean).join(", ");

  return (
    <div className="app">
      <header className="topbar">
        {view === "ask" && (
          <button className="icon-btn menu-btn" aria-label="Open history" onClick={() => setHistoryOpen(!historyOpen)}>
            <Icon name="menu" />
          </button>
        )}
        <Logo />
        <ScopeSwitcher
          auth={auth}
          sections={shelves.sections}
          selected={shelves.option}
          onSelect={shelves.setScope}
          onChanged={shelves.reload}
          onNewWorkspace={() => setCreating(true)}
        />
        {/* students have one destination, so no tabs */}
        <nav className="nav" aria-label="Main" style={isFaculty ? undefined : { visibility: "hidden" }}>
          <NavLink to="/" end>
            Ask
          </NavLink>
          {/* Library always opens on the overview of every library */}
          {isFaculty && (
            <NavLink to="/library" onClick={() => shelves.setScope(null)}>
              Library
            </NavLink>
          )}
        </nav>
        <div className="topbar-right">
          <Notices token={auth.token} />
          <button
            className="icon-btn theme-btn"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={toggleTheme}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
          <div className="me" title={auth.sub}>
            <div className="avatar">{name[0]?.toUpperCase()}</div>
            <div className="me-meta">
              <b>{name}</b>
              <small>{roleLine}</small>
            </div>
          </div>
          <button className="icon-btn signout-btn" aria-label="Sign out" title="Sign out" onClick={auth.logout}>
            <Icon name="signout" />
          </button>
        </div>
      </header>

      <div className={`body${view === "library" ? " body-wide" : ""}`}>
        <Routes>
          <Route
            path="/"
            element={
              <ChatPage
                auth={auth}
                shelves={shelves}
                historyOpen={historyOpen}
                onCloseHistory={() => setHistoryOpen(false)}
              />
            }
          />
          <Route
            path="/library"
            element={
              isFaculty ? (
                <LibraryPage auth={auth} shelves={shelves} onNewWorkspace={() => setCreating(true)} />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route path="/admin" element={<Navigate to="/library" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      {creating && (
        <NewWorkspaceDialog
          token={auth.token}
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await shelves.reload();
            shelves.setScope(id);
            navigate("/library");
          }}
        />
      )}
      <SpineTooltip />
    </div>
  );
}
