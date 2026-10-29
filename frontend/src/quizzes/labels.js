export const TYPES = ["mcq", "short", "long"];
export const TYPE_LABEL = { mcq: "Multiple choice", short: "Short answer", long: "Long answer" };
export const DIFFICULTY_LABEL = { 1: "Recall", 2: "Apply", 3: "Analyse" };

/** "A", "B", ... for option letters. */
export const letter = (i) => String.fromCharCode(65 + i);

/** Toggles `value` in a list (for multi-select segmented buttons). */
export const toggled = (list, value) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
