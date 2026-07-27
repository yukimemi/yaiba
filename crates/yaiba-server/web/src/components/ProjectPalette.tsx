import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo } from "../api";

interface Props {
  projects: ProjectInfo[];
  active: string;
  onPick: (name: string) => void;
  onCreate: (name: string) => void;
  onRename: (from: string, to: string) => void;
  onForget: (name: string) => void;
  onClose: () => void;
}

/**
 * What the palette is asking for right now.
 *
 * A mode rather than three overlays: all of them read and write the same
 * one-line input, and the list stays on screen behind every one, so you
 * can still see what you are acting on.
 */
type Mode =
  | { kind: "filter" }
  | { kind: "rename"; from: string }
  /** Forget reads as destructive even though it isn't, so it asks first. */
  | { kind: "confirm"; target: string };

/**
 * Score a subsequence match, or return null when `query` isn't one.
 *
 * Deliberately small: the candidate list is the projects you have, which
 * is a handful, so the ranking only has to be *sensible* — reward letters
 * typed in a run and letters starting a word, since those are what makes
 * `wk` mean `work-kata` rather than `weekly-backlog`.
 */
function score(name: string, query: string): number | null {
  if (!query) return 0;
  const haystack = name.toLowerCase();
  const needle = query.toLowerCase();
  let at = 0;
  let total = 0;
  let previous = -1;
  for (const ch of needle) {
    const found = haystack.indexOf(ch, at);
    if (found === -1) return null;
    if (found === previous + 1) total += 8;
    if (found === 0 || /[^a-z0-9]/.test(haystack[found - 1] ?? "")) total += 6;
    // Earlier is better, but never enough to outweigh a contiguous run.
    total -= found * 0.1;
    previous = found;
    at = found + 1;
  }
  return total;
}

export function ProjectPalette({
  projects,
  active,
  onPick,
  onCreate,
  onRename,
  onForget,
  onClose,
}: Props) {
  const [mode, setMode] = useState<Mode>({ kind: "filter" });
  const [query, setQuery] = useState("");
  // Start on the project you are looking at, not on row 0. An empty query
  // scores every project the same, so the list arrives in server order and
  // row 0 is whichever project happens to be first — a blind <enter>
  // would then switch you somewhere arbitrary.
  const [cursor, setCursor] = useState(() => {
    const at = projects.findIndex((p) => p.name === active);
    return at === -1 ? 0 : at;
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => {
    // Only filtering filters. Rename and confirm keep the whole list on
    // screen, so the row being acted on stays visible.
    if (mode.kind !== "filter") return projects;
    return projects
      .map((project) => ({ project, score: score(project.name, query) }))
      .filter((row): row is { project: ProjectInfo; score: number } => row.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((row) => row.project);
  }, [projects, query, mode.kind]);

  // A filtered-away cursor must not point past the end, or <enter> would
  // pick nothing and read as the palette ignoring you.
  const index = Math.min(cursor, Math.max(matches.length - 1, 0));
  const current: ProjectInfo | undefined = matches[index];

  /** Typing a name nothing matches is how you make a new one. */
  const creatable =
    mode.kind === "filter" && query.trim().length > 0 && matches.length === 0
      ? query.trim()
      : null;

  useEffect(() => inputRef.current?.focus(), [mode.kind]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [index, matches.length]);

  const move = (delta: number) => {
    if (matches.length === 0) return;
    setCursor((at) => {
      const from = Math.min(at, matches.length - 1);
      // Wrap: a list this short is quicker to reach from either end.
      return (from + delta + matches.length) % matches.length;
    });
  };

  const backToFilter = () => {
    setMode({ kind: "filter" });
    setQuery("");
  };

  const commit = () => {
    if (mode.kind === "rename") {
      const to = query.trim();
      if (to && to !== mode.from) onRename(mode.from, to);
      else backToFilter();
      return;
    }
    if (mode.kind === "confirm") {
      onForget(mode.target);
      return;
    }
    if (creatable) {
      onCreate(creatable);
      return;
    }
    if (current) onPick(current.name);
    else onClose();
  };

  const startRename = (from: string) => {
    setMode({ kind: "rename", from });
    setQuery(from);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Every branch stops here rather than reaching the app's global
    // handler, which would move the task cursor behind the palette.
    const key = e.key;
    if (key === "Escape" || (e.ctrlKey && key === "[")) {
      if (mode.kind === "filter") onClose();
      else backToFilter();
    } else if (key === "Enter") {
      commit();
    } else if (mode.kind !== "filter") {
      // Rename and confirm own the input; nothing below applies to them.
      return;
    } else if (key === "ArrowDown" || (e.ctrlKey && key === "n")) {
      move(1);
    } else if (key === "ArrowUp" || (e.ctrlKey && key === "p")) {
      move(-1);
    } else if (e.ctrlKey && key === "r" && current) {
      startRename(current.name);
    } else if (e.ctrlKey && key === "d" && current) {
      setMode({ kind: "confirm", target: current.name });
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const sigil =
    mode.kind === "rename" ? "rename" : mode.kind === "confirm" ? "forget" : ":proj";

  const placeholder =
    mode.kind === "rename"
      ? `new name for ${mode.from}`
      : "type to filter, or a name that does not exist yet";

  return (
    <div className="palette" onMouseDown={onClose}>
      <div
        className="palette__panel"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="projects"
      >
        <div className="palette__prompt">
          <span className="palette__sigil">{sigil}</span>
          {mode.kind === "confirm" ? (
            <span className="palette__ask">
              forget <strong>{mode.target}</strong>? it leaves the list — the
              database stays on disk
            </span>
          ) : (
            <input
              ref={inputRef}
              className="palette__input"
              value={query}
              spellCheck={false}
              autoComplete="off"
              placeholder={placeholder}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={onKeyDown}
            />
          )}
          {mode.kind === "filter" && (
            <span className="palette__count">
              {matches.length}/{projects.length}
            </span>
          )}
        </div>

        {/* Confirm shows no input, so something still has to hold focus
            and take the keys. */}
        {mode.kind === "confirm" && (
          <input
            ref={inputRef}
            className="palette__offscreen"
            value=""
            readOnly
            onKeyDown={onKeyDown}
          />
        )}

        <ul className="palette__list" ref={listRef} role="listbox">
          {matches.map((project, row) => {
            const onCursor = mode.kind === "filter" && row === index;
            const doomed = mode.kind === "confirm" && project.name === mode.target;
            return (
              <li
                key={project.name}
                role="option"
                aria-selected={onCursor}
                className={`palette__row${onCursor ? " is-cursor" : ""}${
                  doomed ? " is-doomed" : ""
                }`}
                onMouseDown={() => {
                  if (mode.kind === "filter") onPick(project.name);
                }}
              >
                <span className="palette__name">{project.name}</span>
                <span className="palette__meta">
                  {project.name === active ? "current" : ""}
                </span>
                <span className="palette__peers">
                  {project.ticket === null
                    ? "no sync"
                    : project.peers === 1
                      ? "1 peer"
                      : `${project.peers} peers`}
                </span>
                <span className="palette__db" title={project.db}>
                  {project.db}
                </span>
                {/* Only on the row under the cursor. On every row this is
                    a wall of buttons, and a `forget` easy to mis-click. */}
                {onCursor && (
                  <span className="palette__actions">
                    <button
                      type="button"
                      className="palette__action"
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        startRename(project.name);
                      }}
                    >
                      rename
                    </button>
                    <button
                      type="button"
                      className="palette__action"
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        setMode({ kind: "confirm", target: project.name });
                      }}
                    >
                      forget
                    </button>
                  </span>
                )}
              </li>
            );
          })}

          {creatable && (
            <li
              className="palette__row is-cursor palette__create"
              role="option"
              aria-selected
              onMouseDown={(e) => {
                e.stopPropagation();
                onCreate(creatable);
              }}
            >
              ＋ new project <strong>{creatable}</strong>
            </li>
          )}

          {mode.kind === "filter" && !creatable && matches.length === 0 && (
            <li className="palette__empty">no project matches</li>
          )}
        </ul>

        <div className="palette__foot">
          {mode.kind === "rename" &&
            "enter rename · esc back — the database keeps the name it was made with"}
          {mode.kind === "confirm" && "enter forget · esc back"}
          {mode.kind === "filter" &&
            (creatable
              ? "enter creates it · esc cancel"
              : "^n / ^p move · enter switch · ^r rename · ^d forget · esc cancel")}
        </div>
      </div>
    </div>
  );
}
