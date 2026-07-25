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
}

export function StatusLine({
  mode,
  cmdline,
  onCmdChange,
  onCmdKey,
  message,
  pending,
  hint,
}: Props) {
  const typing = mode === "command" || mode === "search";

  return (
    <footer className="status">
      {typing ? (
        <span className="status__cmd">
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
