import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Suspense, lazy } from "react";
import InFlightManager from "@/components/InFlightManager";
import SyncNotifications from "@/components/SyncNotifications";
import AutoSyncScheduler from "@/lib/autoSyncScheduler";
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";

// The OIDC callback (crypto + JWKS + token exchange) must stay out of the
// eager chunk — it only ever downloads for users completing a sign-in.
const AuthCallbackPage = lazy(() => import("./pages/AuthCallbackPage.tsx"));

const App = () => (
  <TooltipProvider>
    <Toaster />
    <Sonner />
    {/* Non-blocking in-flight action indicator + cancel-conflict dialog. */}
    <InFlightManager />
    {/* Queued keep-or-delete prompts for server-side deletions. */}
    <SyncNotifications />
    {/* Background auto-sync — loads the engine lazily, only when configured. */}
    <AutoSyncScheduler />
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route
          path="/auth/callback"
          element={
            <Suspense
              fallback={
                <div className="flex h-dvh items-center justify-center bg-background">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                </div>
              }
            >
              <AuthCallbackPage />
            </Suspense>
          }
        />
        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </TooltipProvider>
);

export default App;
