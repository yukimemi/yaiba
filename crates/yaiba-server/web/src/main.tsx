import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { applyTheme, initialTheme } from "./theme";
import "./styles.css";

// Before the first render, so a light-theme user never sees a dark flash.
applyTheme(initialTheme());

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
