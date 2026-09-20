import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import InFlightManager from "@/components/InFlightManager";
import AutoSyncScheduler from "@/lib/autoSyncScheduler";
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";

const App = () => (
  <TooltipProvider>
    <Toaster />
    <Sonner />
    {/* Non-blocking in-flight action indicator + cancel-conflict dialog. */}
    <InFlightManager />
    {/* Background auto-sync — loads the engine lazily, only when configured. */}
    <AutoSyncScheduler />
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Index />} />
        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </TooltipProvider>
);

export default App;
