import { createContext, useContext, useEffect, useState } from "react";
import { smoothly } from "./ui/transition";

const ThemeContext = createContext(null);

/**
 * Wraps the app to provide the current light/dark theme and a way to switch it, keeping the choice saved for next time.
 */
export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(
    () => document.documentElement.getAttribute("data-theme") || "dark"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  /**
   * Switches the theme between dark and light, cross-fading the page. The
   * attribute is set right away (not only in the effect) so the transition
   * captures the new colours.
   */
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    smoothly(() => {
      document.documentElement.setAttribute("data-theme", next);
      setTheme(next);
    });
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>
  );
}

/**
 * Provides the current theme and the function to toggle it to any component that needs it.
 */
export function useTheme() {
  return useContext(ThemeContext);
}
