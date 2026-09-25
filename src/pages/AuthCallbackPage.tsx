import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { completeLogin, OidcError } from '@/lib/oidcAuth';
import { refreshAutoSyncScheduler } from '@/lib/autoSyncSchedulerControl';

/**
 * OAuth redirect landing page for the /auth/callback route.
 *
 * Validates `state` against the pending login (sessionStorage), exchanges the
 * authorization code (PKCE), validates the id_token against the issuer's
 * JWKS and stores the session. Then navigates to the stored pre-login
 * location (or "/").
 *
 * Lazy-loaded from App.tsx so the OIDC machinery never enters the eager chunk.
 */

export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  /** Guard against StrictMode double-effect running the exchange twice — the
   * second run would fail on a consumed code. */
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    completeLogin(params)
      .then(({ returnTo }) => {
        // A fresh session may enable auto-sync — pick up the scheduler.
        refreshAutoSyncScheduler();
        navigate(returnTo || '/', { replace: true });
      })
      .catch((e: unknown) => {
        setError(e instanceof OidcError ? e.message : 'Sign-in failed unexpectedly');
      });
  }, [navigate]);

  return (
    <div className="flex h-dvh items-center justify-center bg-background px-4">
      <div className="max-w-sm w-full space-y-4 text-center" data-testid="auth-callback">
        {error === null ? (
          <>
            <Loader2 size={28} className="mx-auto animate-spin text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">Completing sign-in…</p>
          </>
        ) : (
          <>
            <TriangleAlert size={28} className="mx-auto text-amber-600" aria-hidden="true" />
            <p className="text-sm text-foreground" data-testid="auth-callback-error">
              {error}
            </p>
            <Button type="button" variant="secondary" onClick={() => navigate('/', { replace: true })}>
              Back to notes
            </Button>
          </>
        )}
      </div>
    </div>
  );
}