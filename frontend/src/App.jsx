import { useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./auth/useAuth";
import { useTheme } from "./ThemeContext";
import EmailLoginPage from "./auth/EmailLoginPage";
import VerifyPage from "./auth/VerifyPage";
import ChatPage from "./chat/ChatPage";
import LibraryPage from "./library/LibraryPage";
import MyAssessmentsPage from "./quizzes/MyAssessmentsPage";
import ScopeSwitcher from "./shell/ScopeSwitcher";
import Notices from "./shell/Notices";
import NewWorkspaceDialog from "./shell/NewWorkspaceDialog";
import { useShelves } from "./shell/useShelves";
import Icon from "./ui/Icons";
import Logo from "./ui/Logo";
import { SpineTooltip } from "./ui/Shelf";
import { smoothly } from "./ui/transition";
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
  const view =
    isFaculty && location.pathname.startsWith("/library")
      ? "library"
      : !isFaculty && location.pathname.startsWith("/work")
        ? "work"
        : "ask";
  const [libraryMounted, setLibraryMounted] = useState(view === "library");
  if (view === "library" && !libraryMounted) setLibraryMounted(true);
  const [workMounted, setWorkMounted] = useState(view === "work");
  if (view === "work" && !workMounted) setWorkMounted(true);
  const name = nameFromEmail(auth.sub);
  // The one shelf choice both views follow: in the topbar on Library, at
  // the top of the history sidebar on Ask.
  const switcher = (
    <ScopeSwitcher
      auth={auth}
      sections={shelves.sections}
      selected={shelves.option}
      onSelect={shelves.setScope}
      onChanged={shelves.reload}
      onNewWorkspace={() => setCreating(true)}
    />
  );
  // Ask <-> Library as a view transition (sidebar slides, switcher moves)
  function go(e, to) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new tab etc.
    e.preventDefault();
    if (location.pathname !== to) smoothly(() => navigate(to));
  }
  const roleLine = isFaculty
    ? "Faculty"
    : ["Student", auth.claims?.dept?.toUpperCase()].filter(Boolean).join(", ");

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          {view === "ask" && (
            <button className="icon-btn menu-btn" aria-label="Open history" onClick={() => setHistoryOpen(!historyOpen)}>
              <Icon name="menu" />
            </button>
          )}
          <Logo />
          {/* On Ask the switcher sits in the history sidebar instead */}
          {view === "library" && switcher}
        </div>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end onClick={(e) => go(e, "/")}>
            Ask
          </NavLink>
          {/* Library opens on whatever the switcher has picked ("All my shelves" = the overview) */}
          {isFaculty ? (
            <NavLink to="/library" onClick={(e) => go(e, "/library")}>
              Library
            </NavLink>
          ) : (
            <NavLink to="/work" onClick={(e) => go(e, "/work")}>
              Quizzes
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

      {/* Both views stay mounted and the inactive one is only hidden, so
          switching keeps their state (open conversation, history, library
          tab, scroll) instead of reloading everything each time. */}
      <div className="body">
        <div className={`view view-ask${view === "ask" ? "" : " is-hidden"}`} inert={view !== "ask"}>
          <ChatPage
            auth={auth}
            shelves={shelves}
            switcher={switcher}
            historyOpen={historyOpen}
            onCloseHistory={() => setHistoryOpen(false)}
          />
        </div>
        {/* mounted on first visit, then kept */}
        {libraryMounted && (
          <div className={`view view-library${view === "library" ? "" : " is-hidden"}`} inert={view !== "library"}>
            <LibraryPage
              auth={auth}
              shelves={shelves}
              active={view === "library"}
              onNewWorkspace={() => setCreating(true)}
            />
          </div>
        )}
        {workMounted && (
          <div className={`view view-library${view === "work" ? "" : " is-hidden"}`} inert={view !== "work"}>
            <MyAssessmentsPage auth={auth} active={view === "work"} />
          </div>
        )}
        <Routes>
          <Route path="/" element={null} />
          <Route path="/work" element={isFaculty ? <Navigate to="/" replace /> : null} />
          <Route path="/library" element={isFaculty ? null : <Navigate to="/" replace />} />
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
