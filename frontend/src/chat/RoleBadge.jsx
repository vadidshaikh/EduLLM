/**
 * Shows a small badge with the user's current role (like "student" or "faculty"), or nothing if there's no role.
 */
export default function RoleBadge({ role }) {
  if (!role) return null;
  return <span className="role-badge">Viewing as: {role}</span>;
}
