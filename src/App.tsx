import { BrowserRouter, Route, Routes } from "react-router-dom";
import { registerJSRunner } from "@/lib/jsRunner";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";
import PreviewBanner from "./components/PreviewBanner.tsx";

// Register code block runners
registerJSRunner();

// PR preview builds set VITE_PREVIEW="true"; the banner strips out otherwise.
const IS_PREVIEW = import.meta.env.VITE_PREVIEW === "true";
const PREVIEW_LABEL = import.meta.env.VITE_PREVIEW_LABEL;
const STORAGE_NAMESPACE = import.meta.env.VITE_STORAGE_NAMESPACE;

const App = () => (
  <TooltipProvider>
    <Toaster />
    <Sonner />
    <div className="flex h-dvh flex-col">
      {IS_PREVIEW && (
        <PreviewBanner branch={PREVIEW_LABEL} storageIsolation={Boolean(STORAGE_NAMESPACE)} />
      )}
      <main className="flex-1 min-h-0 overflow-hidden">
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <Routes>
            <Route path="/" element={<Index />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </main>
    </div>
  </TooltipProvider>
);

export default App;
