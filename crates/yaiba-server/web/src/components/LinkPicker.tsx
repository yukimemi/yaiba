import { useEffect, useRef, useState } from "react";
import { stepCursor } from "../notes";
import { t } from "../i18n";

interface Props {
  urls: string[];
  onPick: (url: string) => void;
  onClose: () => void;
}

/**
 * The list `gx` shows when a row's notes hold more than one link.
 *
 * Dressed as `ProjectPalette` and kept out of it: the palette carries
 * filter / rename / confirm modes this has no use for. A readOnly input
 * holds focus, as the palette's confirm mode does, and takes every key so
 * the app's window handler never sees them.
 */
export function LinkPicker({ urls, onPick, onClose }: Props) {
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const pick = (url: string) => {
    onClose();
    onPick(url);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const key = e.key;
    if (key === "Escape" || (e.ctrlKey && key === "[")) {
      onClose();
    } else if (key === "Enter") {
      const url = urls[cursor];
      if (url) pick(url);
    } else if (key === "ArrowDown" || key === "j" || (e.ctrlKey && key === "n")) {
      setCursor((at) => stepCursor(at, 1, urls.length));
    } else if (key === "ArrowUp" || key === "k" || (e.ctrlKey && key === "p")) {
      setCursor((at) => stepCursor(at, -1, urls.length));
    }
    // Swallow everything, handled or not: the picker owns the keyboard.
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="palette" onMouseDown={onClose}>
      <div
        className="palette__panel"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("links")}
      >
        <input
          ref={inputRef}
          className="palette__offscreen"
          value=""
          readOnly
          autoFocus
          onKeyDown={onKeyDown}
        />
        <ul className="palette__list" ref={listRef} role="listbox">
          {urls.map((url, row) => (
            <li
              key={url}
              role="option"
              aria-selected={row === cursor}
              className={`palette__row${row === cursor ? " is-cursor" : ""}`}
              onMouseDown={() => pick(url)}
            >
              <span className="palette__name">{url}</span>
            </li>
          ))}
        </ul>
        <div className="palette__foot">
          {t("j / k move · enter open · esc cancel")}
        </div>
      </div>
    </div>
  );
}
