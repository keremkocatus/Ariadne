import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "sonner";
import "./lib/monaco-setup";
import App from "./App";
import "./index.css";

// Apply the persisted theme before the first paint to avoid a flash of the wrong theme.
// (App also keeps data-theme in sync once the store is live.)
function initialTheme(): "light" | "dark" {
  try {
    const raw = localStorage.getItem("ariadne-ui");
    return JSON.parse(raw ?? "")?.state?.settings?.theme === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
const theme = initialTheme();
document.documentElement.setAttribute("data-theme", theme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <Toaster theme={theme} position="bottom-right" toastOptions={{ style: { fontSize: "12px" } }} />
  </React.StrictMode>,
);
