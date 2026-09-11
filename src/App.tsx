import { BrowserRouter, Route, Routes } from "react-router-dom";
import { registerJSRunner } from "@/lib/jsRunner";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import InFlightManager from "@/components/InFlightManager";
import Index from "./pages/Index.tsx";
import ShareView from "./pages/ShareView.tsx";
import NotFound from "./pages/NotFound.tsx";

// Register code block runners
registerJSRunner();

const App = () => (
  <TooltipProvider>
    <Toaster />
    <Sonner />
    {/* Non-blocking in-flight action indicator + cancel-conflict dialog. */}
    <InFlightManager />
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="/share" element={<ShareView />} />
        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </TooltipProvider>
);

export default App;
