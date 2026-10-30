export const TYPES = ["mcq", "short", "long"];
// Quizzes are multiple choice (answered and marked in the app); assignments
// are written (handed in and checked on paper).
export const WRITTEN = ["short", "long"];
export const MAX_ASSIGNMENT_QUESTIONS = 25;
export const TYPE_LABEL = { mcq: "Multiple choice", short: "Short answer", long: "Long answer" };
export const DIFFICULTY_LABEL = { 1: "Recall", 2: "Apply", 3: "Analyse" };

/** "A", "B", ... for option letters. */
export const letter = (i) => String.fromCharCode(65 + i);

/** Toggles `value` in a list (for multi-select segmented buttons). */
export const toggled = (list, value) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
