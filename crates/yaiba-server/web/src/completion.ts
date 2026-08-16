/**
 * `<tab>` completion for the `:` command line — vim's `wildmode=full`.
 *
 * One press replaces the half-typed token with the first match and puts
 * the whole list on screen; further presses walk it. The cycle includes
 * the text as typed, at index -1, so walking off either end gives you
 * back exactly what you wrote rather than stranding you on a candidate
 * you never wanted.
 */

import { COMMANDS, type ArgContext } from "./commands";

export interface Completion {
  /** Everything before the token being completed; cycling never touches it. */
  head: string;
  /** The token as typed. Index -1 puts it back. */
  base: string;
  items: string[];
  index: number;
}

/**
 * Candidates for the token at the end of `line`, or null when there is
 * nothing to offer — an unknown command, an argument with no vocabulary,
 * or a prefix that matches none of it.
 */
export function startCompletion(
  line: string,
  ctx: ArgContext,
): Completion | null {
  // The token under completion is the trailing run of non-spaces, which
  // is empty when the line ends in one — `:view ` offers every view.
  const token = /\S*$/.exec(line)?.[0] ?? "";
  const head = line.slice(0, line.length - token.length);
  const words = head.trim().split(/\s+/).filter(Boolean);

  // `words` goes to the spec as well as its length: a command with
  // sub-verbs — `:cal week`, `:cal region` — has a different vocabulary
  // per branch, and the position alone cannot say which branch it is on.
  const pool =
    words.length === 0
      ? COMMANDS.map((c) => c.name)
      : (findSpec(words[0])?.args?.(ctx, words.length, words) ?? []);

  const wanted = token.toLowerCase();
  const items = pool.filter((c) => c.toLowerCase().startsWith(wanted));
  if (!items.length) return null;
  return { head, base: token, items, index: -1 };
}

/** Step through the cycle, wrapping through the as-typed text at both ends. */
export function stepCompletion(c: Completion, step: number): Completion {
  const size = c.items.length + 1; // the matches, plus "as typed"
  const at = (((c.index + step + 1) % size) + size) % size;
  return { ...c, index: at - 1 };
}

/** The command line as it reads with `c.index` selected. */
export function completionLine(c: Completion): string {
  return c.head + (c.index < 0 ? c.base : c.items[c.index]);
}

function findSpec(head: string) {
  return COMMANDS.find((c) => c.name === head || c.aliases?.includes(head));
}
