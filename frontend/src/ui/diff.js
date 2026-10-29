/**
 * Line-by-line diff of two texts, for comparing a note with a redraft.
 * Returns [{type: "same" | "del" | "add", text}] in reading order, from a
 * longest-common-subsequence table (notes are a few hundred lines at most).
 */
export function diffLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  // lcs[i][j] = length of the LCS of a[i:] and b[j:]
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ type: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) out.push({ type: "del", text: a[i++] });
  while (j < b.length) out.push({ type: "add", text: b[j++] });
  return out;
}

/**
 * A deck as plain text, one block per slide, so decks can be diffed like notes.
 */
export function slidesText(slides) {
  return slides
    .map((s, n) => [`${n + 1}. ${s.title}`, ...s.bullets.map((b) => `   - ${b}`), s.notes ? `   Notes: ${s.notes}` : null]
      .filter(Boolean)
      .join("\n"))
    .join("\n\n");
}

/**
 * Splits notes into the text before the first "## " heading and one string
 * per "## " section (heading included), so a section can be redrafted and
 * put back. Joining `[intro, ...sections]` gives the original text back.
 */
export function splitSections(markdown) {
  const parts = markdown.split(/^(?=## )/m);
  if (parts[0].startsWith("## ")) return { intro: "", sections: parts };
  return { intro: parts[0], sections: parts.slice(1) };
}
