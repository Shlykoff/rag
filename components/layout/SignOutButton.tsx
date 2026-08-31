"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabaseClient } from "@/lib/supabase/browser-client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    setError(null);
    setPending(true);
    try {
      const supabase = getBrowserSupabaseClient();
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) {
        setError(`Не удалось выйти: ${signOutError.message}`);
        setPending(false);
        return;
      }
      // Full navigation (not just router.refresh()) so every server
      // component / proxy.ts check on the next request sees the cleared
      // session cookies from a clean request cycle -- same rationale as
      // LoginForm.tsx's own comment on its post-sign-in navigation.
      router.push("/login");
      router.refresh();
    } catch {
      setError("Не удалось связаться с сервером авторизации. Проверьте, что Supabase запущен.");
      setPending(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", alignItems: "flex-start" }}>
      <button type="button" className="btn btn-ghost btn-sm" onClick={handleSignOut} disabled={pending}>
        {pending ? "Выходим…" : "Выйти"}
      </button>
      {error ? (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
