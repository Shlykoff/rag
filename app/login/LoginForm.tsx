"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabaseClient } from "@/lib/supabase/browser-client";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";

const DEMO_EMAIL = "demo@example.com";
const DEMO_PASSWORD = "demo-password-123";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState(DEMO_EMAIL);
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [showManualFields, setShowManualFields] = useState(false);
  const [pending, setPending] = useState<"demo" | "manual" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signIn(loginEmail: string, loginPassword: string, mode: "demo" | "manual") {
    setError(null);
    setPending(mode);
    try {
      const supabase = getBrowserSupabaseClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password: loginPassword,
      });
      if (signInError) {
        setError(
          signInError.message === "Invalid login credentials"
            ? "Неверный email или пароль."
            : `Не удалось войти: ${signInError.message}`
        );
        setPending(null);
        return;
      }
      // Full navigation (not just router.refresh()) so every server
      // component / proxy.ts check on the next request sees the
      // freshly-set session cookies from a clean request cycle.
      router.push("/");
      router.refresh();
    } catch {
      setError("Не удалось связаться с сервером авторизации. Проверьте, что Supabase запущен.");
      setPending(null);
    }
  }

  function handleDemoClick() {
    void signIn(DEMO_EMAIL, DEMO_PASSWORD, "demo");
  }

  function handleManualSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void signIn(email, password, "manual");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <button
        type="button"
        className="btn btn-primary"
        style={{ width: "100%" }}
        onClick={handleDemoClick}
        disabled={pending !== null}
      >
        {pending === "demo" ? "Входим…" : "Попробовать демо"}
      </button>
      <p className="field-hint" style={{ textAlign: "center" }}>
        Вход под тестовым аккаунтом ({DEMO_EMAIL}) с двумя уже загруженными
        документами — не нужна регистрация.
      </p>

      {error ? (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="login-divider" role="separator" aria-label="или">
        <span>или</span>
      </div>

      <GoogleSignInButton />

      <div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setShowManualFields((v) => !v)}
          aria-expanded={showManualFields}
        >
          {showManualFields ? "Скрыть вход по логину и паролю" : "Войти с другими данными"}
        </button>
      </div>

      {showManualFields ? (
        <form onSubmit={handleManualSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              className="input"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Пароль</label>
            <input
              id="password"
              name="password"
              type="password"
              className="input"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button type="submit" className="btn btn-secondary" disabled={pending !== null}>
            {pending === "manual" ? "Входим…" : "Войти"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
