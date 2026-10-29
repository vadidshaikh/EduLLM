import { useCallback, useEffect, useState } from "react";
import { listMyClassrooms, listWorkspaces } from "../api/client";
import { hashString } from "../ui/spines";
import { smoothly } from "../ui/transition";

const SCOPE_KEY = "edullm_scope";

// The institute library (documents outside any workspace) in the switcher.
export const LIBRARY = "library";

// The backend's INSTITUTE scope id (app/db/queries.py). Sent as a query's
// scope_id it means "the institute library": institute-wide docs only.
const INSTITUTE_SCOPE_ID = "00000000-0000-0000-0000-000000000001";

const SHARED_COLORS = ["var(--blue)", "var(--deep)", "var(--sky)"];

/**
 * Colour for a workspace's mark: personal is amber, shared ones a stable
 * pick from the logo's blues.
 */
function workspaceColor(kind, key) {
  if (kind === "personal") return "var(--tone-6)";
  return SHARED_COLORS[hashString(String(key)) % SHARED_COLORS.length];
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Turns a workspace row into a switcher option.
 */
function workspaceOption(w) {
  return {
    id: w.id,
    searchId: w.id,
    kind: w.kind,
    color: workspaceColor(w.kind, w.id),
    name: w.kind === "personal" ? "My workspace" : w.name,
    sub:
      w.kind === "personal"
        ? "Personal, only you"
        : `Shared, ${w.member_count} faculty, ${plural(w.classroom_count, "classroom")}`,
    workspace: w,
  };
}

/**
 * Loads what the user can switch between and remembers the one choice that
 * both views follow (`option`, set with `setScope`):
 * - "All" (nothing picked): Ask searches everything the user can read;
 *   Library shows an overview of their libraries. Picked explicitly: the
 *   menu's first entry, or clearing Ask's scope chip. Switching between Ask
 *   and Library keeps the choice.
 * - The institute library, or one workspace (faculty) / classroom (student):
 *   Ask searches only it (`option.searchId`, sent as /query's scope_id);
 *   Library shows its docs.
 * `sections` are the switcher menu's groups of options.
 */
export function useShelves(auth) {
  const isFaculty = auth.role === "faculty";
  const [workspaces, setWorkspaces] = useState([]);
  const [classrooms, setClassrooms] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [scope, setScopeState] = useState(() => localStorage.getItem(SCOPE_KEY) || null);

  const reload = useCallback(async () => {
    try {
      if (isFaculty) setWorkspaces(await listWorkspaces(auth.token));
      else setClassrooms(await listMyClassrooms(auth.token));
    } catch {
      // keep what we had; the switcher just won't update
    } finally {
      setLoaded(true);
    }
  }, [auth.token, isFaculty]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount
    reload();
  }, [reload]);

  const setScope = useCallback((id) => {
    if (id) localStorage.setItem(SCOPE_KEY, id);
    else localStorage.removeItem(SCOPE_KEY);
    smoothly(() => setScopeState(id || null));
  }, []);

  const everything = {
    id: null,
    searchId: null,
    kind: "all",
    color: "var(--accent)",
    name: isFaculty ? "All my shelves" : "All my classes",
    sub: isFaculty ? "Institute library and every workspace" : "Institute docs and every classroom",
  };
  const library = {
    id: LIBRARY,
    searchId: INSTITUTE_SCOPE_ID,
    kind: "library",
    color: "var(--tone-5)",
    name: isFaculty ? "Institute library" : "Institute docs",
    sub: isFaculty ? "Institute-wide, every faculty member" : "Institute-wide documents only",
  };

  let sections;
  if (isFaculty) {
    sections = [
      { heading: null, options: [everything] },
      { heading: "Institute", options: [library] },
      { heading: "Personal", options: workspaces.filter((w) => w.kind === "personal").map(workspaceOption) },
      { heading: "Shared with you", options: workspaces.filter((w) => w.kind === "shared").map(workspaceOption) },
    ];
  } else {
    const classroomOptions = classrooms.map((c) => ({
      id: c.id,
      searchId: c.id,
      kind: "class",
      color: workspaceColor("shared", c.workspace_name),
      name: c.name,
      sub: [c.subject, c.workspace_name].filter(Boolean).join(", "),
    }));
    sections = [
      { heading: null, options: [everything, library] },
      { heading: "Your classrooms", options: classroomOptions },
    ];
  }

  // Nothing picked, or a remembered choice that's gone (left the workspace,
  // classroom archived), is "All".
  const option = sections.flatMap((s) => s.options).find((o) => o.id === scope) ?? everything;

  return { loaded, workspaces, classrooms, reload, sections, option, setScope };
}
