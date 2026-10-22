import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./App.css";

async function start() {
  // Outside Tauri (plain `vite dev` in a browser) there is no backend: serve canned data so the UI can be developed.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installDevMock } = await import("./dev/tauriMock");
    installDevMock();
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void start();
