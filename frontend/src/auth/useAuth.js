import { useCallback, useState } from "react";
import { jwtDecode } from "jwt-decode";

const STORAGE_KEY = "edullm_token";

/**
 * Reads the user information (like role) stored inside a login token, returning nothing if the token is invalid.
 * Example: decodeClaims(validToken) -> { role: 'student', sub: '...' }
 */
function decodeClaims(token) {
  try {
    return jwtDecode(token);
  } catch {
    return null;
  }
}

/**
 * Provides the current login token, user role, and login/logout actions, keeping the token saved in the browser's storage.
 */
export function useAuth() {
  const [token, setToken] = useState(() => localStorage.getItem(STORAGE_KEY));

  const claims = token ? decodeClaims(token) : null;

  /**
   * Saves a new login token to the browser and updates the signed-in state.
   */
  const login = useCallback((newToken) => {
    localStorage.setItem(STORAGE_KEY, newToken);
    setToken(newToken);
  }, []);

  /**
   * Removes the saved login token and signs the user out.
   */
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
