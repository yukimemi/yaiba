import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo } from "../api";

interface Props {
  projects: ProjectInfo[];
  active: string;
  onPick: (name: string) => void;
  onClose: () => void;
}

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

export function ProjectPalette({ projects, active, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => {
    return projects
      .map((project) => ({ project, score: score(project.name, query) }))
      .filter((row): row is { project: ProjectInfo; score: number } => row.score !== null)
      .sort((a, b) => b.score - a.score);
  }, [projects, query]);

  // A filtered-away cursor must not point past the end, or <enter> would
  // pick nothing and read as the palette ignoring you.
  const index = Math.min(cursor, Math.max(matches.length - 1, 0));

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index, matches.length]);

  const move = (delta: number) => {
    if (matches.length === 0) return;
    setCursor((current) => {
      const from = Math.min(current, matches.length - 1);
      // Wrap: a list this short is quicker to reach from either end.
      return (from + delta + matches.length) % matches.length;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Every branch stops here rather than reaching the app's global
    // handler, which would move the task cursor behind the palette.
    if (e.key === "Escape" || (e.ctrlKey && e.key === "[")) {
      onClose();
    } else if (e.key === "Enter") {
      const chosen = matches[index];
      if (chosen) onPick(chosen.project.name);
      else onClose();
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      move(1);
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      move(-1);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="palette" onMouseDown={onClose}>
      <div
        className="palette__panel"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="switch project"
      >
        <div className="palette__prompt">
          <span className="palette__sigil">:proj</span>
          <input
            ref={inputRef}
            className="palette__input"
            value={query}
            spellCheck={false}
            autoComplete="off"
            placeholder="type to filter"
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
          />
          <span className="palette__count">
            {matches.length}/{projects.length}
          </span>
        </div>
        <ul className="palette__list" ref={listRef} role="listbox">
          {matches.map(({ project }, row) => (
            <li
              key={project.name}
              role="option"
              aria-selected={row === index}
              className={`palette__row${row === index ? " is-cursor" : ""}`}
              onMouseDown={() => onPick(project.name)}
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
            </li>
          ))}
          {matches.length === 0 && <li className="palette__empty">no project matches</li>}
        </ul>
        <div className="palette__foot">
          ^n / ^p move · enter switch · esc cancel — every project listed is already syncing
        </div>
      </div>
    </div>
  );
}
