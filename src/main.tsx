import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import { initSentry } from "./lib/sentry";
import "./index.css";

// Show the window as soon as the module loads — the splash is already in the DOM
// because the <script> is at the end of body. This eliminates the flash of a
// black window between Tauri opening and the WebView paint. Runs before any
// React render to guarantee the user sees the splash right away.
getCurrentWebviewWindow().show().catch(() => {});

initSentry();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
