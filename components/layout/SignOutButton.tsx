"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabaseClient } from "@/lib/supabase/browser-client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    setPending(true);
    const supabase = getBrowserSupabaseClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={handleSignOut} disabled={pending}>
      {pending ? "Выходим…" : "Выйти"}
    </button>
  );
}
