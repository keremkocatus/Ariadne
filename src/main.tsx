import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "sonner";
import "./lib/monaco-setup";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <Toaster theme="dark" position="bottom-right" toastOptions={{ style: { fontSize: "12px" } }} />
  </React.StrictMode>,
);
