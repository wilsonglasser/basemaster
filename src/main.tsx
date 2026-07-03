import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import { initSentry } from "./lib/sentry";
import { useAiAgent } from "./state/ai-agent";
import "./index.css";

// Show the window as soon as the module loads — the splash is already in the DOM
// because the <script> is at the end of body. This eliminates the flash of a
// black window between Tauri opening and the WebView paint. Runs before any
// React render to guarantee the user sees the splash right away.
// Also unminimize + focus: a previous close-to-tray run may have left the
// window hidden/minimized, and window_state plugin can restore that state.
{
  const w = getCurrentWebviewWindow();
  w.show().catch(() => {});
  w.unminimize().catch(() => {});
  w.setFocus().catch(() => {});
}

initSentry();

// Load API keys from the OS keyring into memory (they're no longer persisted
// in localStorage).
void useAiAgent.getState().hydrateKeys();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
