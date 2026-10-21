import { createRoot } from "react-dom/client";
import "./lib/posthog";
import App from "./App.tsx";
import "./index.css";
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";

createRoot(document.getElementById("root")!).render(<App />);
