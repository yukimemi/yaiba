import { t } from "./i18n";

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

/**
 * What the far right of the status line offers in each mode.
 *
 * A function rather than a table, because a table would be built once —
 * in whatever language was loaded — and `:lang` would leave the hints
 * behind. The keys inside each line (`j/k`, `⏎`, `esc`) are what you
 * press, so they read the same in either language; only the verbs move.
 */
export function modeHint(mode: Mode): string {
  switch (mode) {
    case "insert":
      return t("⏎ commit · esc cancel");
    case "visual":
      return t("j/k extend · x done · d delete · esc cancel");
    case "command":
      return t("⏎ run · esc cancel");
    case "search":
      return t("⏎ jump · esc cancel");
    case "link":
      return t("pick the task this one waits for · ⏎ confirm · esc cancel");
    case "unlink":
      return t("pick the dependency to cut · ⏎ confirm · esc cancel");
    case "normal":
      return t("j/k move · o new · x done · D link · ? help");
  }
}
