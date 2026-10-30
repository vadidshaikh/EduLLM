import Icon from "../ui/Icons";

const SECTIONS = {
  books: ["Docs", "books"],
  notes: ["Slides", "slides"],
  quizzes: ["Quizzes", "quiz"],
  assignments: ["Assignments", "pen"],
  classrooms: ["Classrooms", "people"],
  faculty: ["Faculty", "user"],
};

/**
 * The Library's left panel, like Ask's history sidebar: the shelf switcher
 * on top, then the picked workspace's sections (`sections`, ids of
 * SECTIONS; none for the overview and the institute library).
 */
export default function LibrarySide({ switcher, sections = [], section, onSection }) {
  return (
    <aside className="lib-side" aria-label="Library">
      <div className="history-top">{switcher}</div>
      {sections.length > 0 && (
        <nav className="lib-nav" aria-label="Workspace">
          {sections.map((id) => (
            <button
              key={id}
              className="h-item"
              aria-current={section === id ? "true" : undefined}
              onClick={() => id !== section && onSection(id)}
            >
              <Icon name={SECTIONS[id][1]} />
              <span>{SECTIONS[id][0]}</span>
            </button>
          ))}
        </nav>
      )}
    </aside>
  );
}
