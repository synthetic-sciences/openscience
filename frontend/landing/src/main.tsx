import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import Landing from "./pages/Landing";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <>
    <Landing />
    <Analytics />
  </>
);
