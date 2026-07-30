import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { applyLang, initialLang } from "./lang";
import { applySplit, initialSplit } from "./split";
import { applyTheme, initialTheme } from "./theme";
import "./styles.css";

// Before the first render, so a light-theme user never sees a dark flash.
applyTheme(initialTheme());
// `<html lang>` before anything is drawn, for the same reason: it is the
// document's, not a component's.
applyLang(initialLang());
// And the same for the split width — doubly so, because `--list-w` is
// where the width *lives*. `App` seeds its state from the same place, but
// nothing there writes the variable, so without this a remembered width
// would be read and then ignored until the next drag.
applySplit(initialSplit());

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
