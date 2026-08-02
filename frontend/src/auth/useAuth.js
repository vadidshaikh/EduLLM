import { useCallback, useState } from "react";
import { jwtDecode } from "jwt-decode";

const STORAGE_KEY = "edullm_token";

function decodeClaims(token) {
  try {
    return jwtDecode(token);
  } catch {
    return null;
  }
}

export function useAuth() {
  const [token, setToken] = useState(() => localStorage.getItem(STORAGE_KEY));

  const claims = token ? decodeClaims(token) : null;

  const login = useCallback((newToken) => {
    localStorage.setItem(STORAGE_KEY, newToken);
    setToken(newToken);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
  }, []);

  return {
    token,
    role: claims?.role ?? null,
    sub: claims?.sub ?? null,
    isAuthenticated: Boolean(token && claims),
    login,
    logout,
  };
}
