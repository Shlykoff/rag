"use client";

// components/auth/GoogleSignInButton.tsx
//
// Additive alongside the existing demo/manual email+password flow in
// app/login/LoginForm.tsx -- this button does not replace it. Kicks off
// Supabase's OAuth redirect flow (`signInWithOAuth`); the actual code
// exchange happens server-side in app/auth/callback/route.ts once Google
// redirects back. This component itself never sees a token/code -- the
// browser just gets redirected to Google, then to the callback route, then
// (via that route's own redirect) back into the app.
//
// If supabase/config.toml's [auth.external.google] client_id/secret are
// still empty placeholders (see .env.example's own comment on this), the
// click still works architecturally -- the browser is sent to Google,
// which then rejects the request -- that failure surfaces on Google's own
// page, not as a crash here.

import { useState } from "react";
import { getBrowserSupabaseClient } from "@/lib/supabase/browser-client";

export function GoogleSignInButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    setPending(true);
    try {
      const supabase = getBrowserSupabaseClient();
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (oauthError) {
        setError(`Не удалось начать вход через Google: ${oauthError.message}`);
        setPending(false);
        return;
      }
      // Success here means the browser is about to navigate away to
      // Google's consent screen -- no further client-side state to manage;
      // this component unmounts as part of that navigation, so `pending`
      // is deliberately never reset to false on the success path.
    } catch {
      setError("Не удалось связаться с сервером авторизации. Проверьте, что Supabase запущен.");
      setPending(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <button
        type="button"
        className="btn btn-secondary"
        style={{ width: "100%" }}
        onClick={handleClick}
        disabled={pending}
      >
        {pending ? "Перенаправляем на Google…" : "Войти через Google"}
      </button>
      {error ? (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
