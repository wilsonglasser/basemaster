import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import { initSentry } from "./lib/sentry";
import "./index.css";

// Mostra a janela assim que o módulo carrega — o splash já está no DOM
// porque o <script> fica no fim do body. Isso elimina o flash de janela
// preta entre a abertura do Tauri e o paint do WebView. Roda antes de
// qualquer render do React pra garantir que user veja o splash direto.
getCurrentWebviewWindow().show().catch(() => {});

initSentry();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
