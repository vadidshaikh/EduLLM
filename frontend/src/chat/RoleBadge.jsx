export default function RoleBadge({ role }) {
  if (!role) return null;
  return <span className="role-badge">Viewing as: {role}</span>;
}
