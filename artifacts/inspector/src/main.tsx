import { createRoot } from "react-dom/client";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

const apiKey = import.meta.env.VITE_MEMORY_API_KEY as string | undefined;

if (apiKey && apiKey.trim() !== "") {
  setAuthTokenGetter(() => apiKey);
} else {
  console.warn(
    "VITE_MEMORY_API_KEY is not set; memory API requests will be unauthenticated.",
  );
}

createRoot(document.getElementById("root")!).render(<App />);
