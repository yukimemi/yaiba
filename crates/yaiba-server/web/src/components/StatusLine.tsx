import { useEffect, useRef } from "react";

import type { Completion } from "../completion";
import type { Mode } from "../mode";

export interface Message {
  text: string;
  kind: "info" | "ok" | "error";
}

interface Props {
  mode: Mode;
  cmdline: string;
  onCmdChange: (value: string) => void;
  onCmdKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  message: Message | null;
  pending: string;
  hint: string;
  completion: Completion | null;
}

export function StatusLine({
  mode,
  cmdline,
  onCmdChange,
  onCmdKey,
  message,
  pending,
  hint,
  completion,
}: Props) {
  const typing = mode === "command" || mode === "search";

  return (
    <footer className="status">
      {typing ? (
        <span className="status__cmd">
          {completion && <Wildmenu completion={completion} />}
          <span className="status__prompt">{mode === "command" ? ":" : "/"}</span>
          <input
            className="status__input"
            value={cmdline}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onCmdChange(e.target.value)}
            onKeyDown={onCmdKey}
          />
        </span>
      ) : (
        <>
          <span
            className={`status__msg${
              message?.kind === "error"
                ? " status__msg--error"
                : message?.kind === "ok"
                  ? " status__msg--ok"
                  : ""
            }`}
          >
            {message?.text ?? ""}
          </span>
          <span className="status__hint">{hint}</span>
        </>
      )}
      <span className="status__pending">{pending}</span>
    </footer>
  );
}

/** Vim's wildmenu: the matches, stacked above the line you are typing. */
function Wildmenu({ completion }: { completion: Completion }) {
  const selected = useRef<HTMLLIElement>(null);

  // The list scrolls once it is taller than the panel, and cycling past
  // the bottom has to bring the selection back into view with it.
  useEffect(() => {
    selected.current?.scrollIntoView({ block: "nearest" });
  }, [completion.index]);

  return (
    <ul className="wildmenu">
      {completion.items.map((item, i) => {
        const on = i === completion.index;
        return (
          <li
            key={item}
            ref={on ? selected : undefined}
            className={`wildmenu__item${on ? " wildmenu__item--on" : ""}`}
          >
            {item}
          </li>
        );
      })}
    </ul>
  );
}
