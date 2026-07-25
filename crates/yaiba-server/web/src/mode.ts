/**
 * Editor modes.
 *
 * `link` / `unlink` are yaiba's own: they behave like an operator
 * waiting for a motion — you pick the other end of a dependency with
 * the same `j` / `k` you navigate with, then confirm.
 */
export type Mode =
  | "normal"
  | "insert"
  | "visual"
  | "command"
  | "search"
  | "link"
  | "unlink";

export const MODE_HINT: Record<Mode, string> = {
  normal: "j/k move · o new · x done · D link · ? help",
  insert: "⏎ commit · esc cancel",
  visual: "j/k extend · x done · d delete · esc cancel",
  command: "⏎ run · esc cancel",
  search: "⏎ jump · esc cancel",
  link: "pick the task this one waits for · ⏎ confirm · esc cancel",
  unlink: "pick the dependency to cut · ⏎ confirm · esc cancel",
};
