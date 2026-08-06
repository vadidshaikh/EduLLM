import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/useAuth";
import EmailLoginPage from "./auth/EmailLoginPage";
import VerifyPage from "./auth/VerifyPage";
import ChatPage from "./chat/ChatPage";
import AdminPage from "./admin/AdminPage";
import RoleBadge from "./chat/RoleBadge";

function RequireAuth({ auth, children }) {
  if (!auth.isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const auth = useAuth();

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="topbar-brand">Edu LLM</span>
        <nav className="topbar-nav">
          {auth.isAuthenticated && (
            <>
              <NavLink to="/" end>
                Chat
              </NavLink>
              {auth.role === "faculty" && <NavLink to="/admin">Admin</NavLink>}
              <RoleBadge role={auth.role} />
              <button className="btn-secondary btn" onClick={auth.logout}>
                Sign out
              </button>
            </>
          )}
        </nav>
      </header>

      <Routes>
        <Route path="/login" element={<EmailLoginPage />} />
        <Route path="/auth/verify" element={<VerifyPage auth={auth} />} />
        <Route
          path="/"
          element={
            <RequireAuth auth={auth}>
              <ChatPage auth={auth} />
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAuth auth={auth}>
              <AdminPage auth={auth} />
            </RequireAuth>
          }
        />
      </Routes>
    </div>
  );
}
