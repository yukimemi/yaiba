import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { t } from "../i18n";
import { noteLinks } from "../notes";

import type { Anchor } from "./DatePicker";

interface Props {
  /** The note as it stands before this panel touches it. */
  value: string;
  anchor: Anchor;
  /** Fires once, with whatever the box holds, when the panel is finished
   * with — blur, click-away, `esc`, or ctrl+⏎ all reach this rather than
   * three separate paths, so "did the edit stick" has one answer, and
   * that one answer is always "save". There is no separate close: a
   * panel with nothing typed into it saves back the value it opened
   * with, which is a no-op. */
  onSave: (text: string) => void;
}

/**
 * The detail a `title` tooltip could never hold: more than one line, and
 * a URL a person can actually click rather than read.
 *
 * Same furniture as `OwnerPicker` — a small box the pointer opens over a
 * cell and that then owns the keyboard until it is done — but the
 * commit rule is different on purpose. A name is one word chosen from a
 * list; a note is prose, typed over several seconds, and `⏎` is a
 * character in it rather than a way to leave. So there is no field this
 * panel *asks* the app to run through the `:` line the way `commitOwner`
 * and `commitDate` do — a note can carry anything, including things the
 * command line would trip over — and there is no keystroke that discards
 * it silently: `esc` and clicking away both save what is there, exactly
 * as blurring the title input does. The only way out with nothing
 * written is never having typed anything.
 */
export function NotesPanel({ value, anchor, onSave }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(value);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 2 });
  // `onSave` must run exactly once per open, however the panel closes —
  // blur, outside click and `esc` can all fire in the same tick.
  const done = useRef(false);
  // The outside-click listener below is registered once, on mount, so
  // that the pointerdown which opened the panel cannot also close it —
  // an effect that re-subscribed on every keystroke would reopen that
  // exact race. Reading `text` state from a closure captured at mount
  // time means every outside click saves whatever was typed in the
  // *first* render, not the latest one — a burst of typing followed by
  // a click away silently reverted to the empty box. `textRef` is kept
  // current on every change so `finish` always reads the live value,
  // the same trick `cursorRef` uses in `App.tsx` for the same reason.
  const textRef = useRef(text);
  textRef.current = text;

  const finish = () => {
    if (done.current) return;
    done.current = true;
    onSave(textRef.current);
  };

  useLayoutEffect(() => {
    const box = panel.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(
      8,
      Math.min(anchor.left, window.innerWidth - box.width - 8),
    );
    const below = anchor.bottom + 2;
    const top =
      below + box.height > window.innerHeight - 8
        ? Math.max(8, anchor.top - box.height - 2)
        : below;
    setPos({ left, top });
  }, [anchor.left, anchor.top, anchor.bottom]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Registered after the pointerdown that opened it, exactly as
  // `OwnerPicker` does, and for the same reason: otherwise the same
  // click that opened the panel would immediately close it again.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node)) finish();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const links = noteLinks(text);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // The app's handler lives on `window`; stopping it here is what
    // keeps `j` / `dd` / every other single-key command from firing
    // while this box is holding ordinary prose.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      finish();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finish();
    }
  };

  return (
    <div
      className="notespanel"
      ref={panel}
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="notespanel__head">
        <span className="notespanel__field">{t("notes")}</span>
      </div>

      <textarea
        className="notespanel__textarea"
        ref={area}
        rows={6}
        value={text}
        spellCheck={false}
        placeholder={t("details, or a link — plain text")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={finish}
      />

      {links.length > 0 && (
        <ul className="notespanel__links">
          {links.map((url, i) => (
            <li key={`${url}:${i}`}>
              <a
                className="notespanel__link"
                href={url}
                target="_blank"
                rel="noreferrer"
                // A click here is a click on a link, not on the panel
                // — it must not fire the save-and-close the outside
                // listener would otherwise read into it. `stopPropagation`
                // alone is not enough: a mousedown on an `<a>` also
                // moves focus off the textarea, which fires `onBlur` →
                // `finish()` → unmount, before the browser gets to the
                // click that would have navigated. `preventDefault`
                // keeps focus on the textarea; the click still fires
                // and still navigates, since that is a separate event
                // from the mousedown whose default it cancelled.
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                {url}
              </a>
            </li>
          ))}
        </ul>
      )}

      <div className="notespanel__foot">
        <span className="notespanel__hint">
          {t("ctrl+⏎ / esc / click away — save & close")}
        </span>
      </div>
    </div>
  );
}
