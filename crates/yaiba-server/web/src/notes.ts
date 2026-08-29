/**
 * The one place a note's text is asked "what URLs are in here".
 *
 * `NotesPanel` uses it to render the live link preview while typing;
 * `TaskList` uses it to pick the row marker's glyph — a plain note gets
 * `✎`, one that carries a link gets a glyph that says so *before* the
 * panel is opened. Two copies of this pattern is exactly the trap
 * `AGENTS.md` already names for a hex field's echo guard: the marker
 * and the preview would drift the moment one of them was tightened (a
 * trailing `)` included in one match but not the other, say) and
 * nothing would catch it.
 */
export function noteLinks(text: string): string[] {
  return [...text.matchAll(/https?:\/\/\S+/g)].map((m) =>
    trimTrailingPunctuation(m[0]),
  );
}

/**
 * A URL matched by `\S+` swallows whatever punctuation follows it in the
 * sentence — `see (https://x.test/foo) for details` matches
 * `https://x.test/foo)`, and `docs: https://x.test/y, then ping me`
 * matches `https://x.test/y,`. Both would link to a path nobody typed.
 *
 * Trailing `.,;:!?'"` are never part of a URL in prose, so they always
 * come off. `)`, `]`, `}` are trickier — a URL can legitimately end in
 * one (Wikipedia's `_(disambiguation)`), so those only come off when
 * they are not balanced by an opener earlier in the same match.
 */
function trimTrailingPunctuation(url: string): string {
  const closers: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (".,;:!?'\"".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opener = closers[last];
    if (opener) {
      const opens = url.split(opener).length - 1;
      const closes = url.split(last).length - 1;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return url;
}
