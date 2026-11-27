"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "./client";

const headings = { signin: "Sign in", signup: "Create an account", forgot: "Reset your password", reset: "Choose a new password" };
type Mode = keyof typeof headings;

export function AccountForm({ mode, token, invalidLink }: { mode: Mode; token?: string; invalidLink: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(invalidLink || (mode === "reset" && !token) ? "This link is invalid or has expired." : "");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    setBusy(true);
    setError("");
    try {
      switch (mode) {
        case "signup": {
          const { error } = await authClient.signUp.email({ name: String(data.get("name")), email, password, callbackURL: "/projects" });
          if (error) throw new Error(error.message || "Could not create your account.");
          setMessage("Check your inbox for a verification link to open your projects.");
          break;
        }
        case "signin": {
          const { error } = await authClient.signIn.email({ email, password, callbackURL: "/projects" });
          if (error) throw new Error(error.code === "EMAIL_NOT_VERIFIED" ? "Check your inbox for a new verification link." : error.message || "Could not sign in.");
          window.location.assign("/projects");
          break;
        }
        case "forgot": {
          const { error } = await authClient.requestPasswordReset({ email, redirectTo: "/account?view=reset" });
          if (error) throw new Error(error.message || "Could not send the reset link.");
          setMessage("If that email has an account, a reset link is on its way.");
          break;
        }
        case "reset": {
          const { error } = await authClient.resetPassword({ token, newPassword: password });
          if (error) throw new Error(error.message || "Request a new reset link.");
          setMessage("Your password has been changed. Sign in with your new password.");
          break;
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request failed. Try again.");
    } finally { setBusy(false); }
  }

  return <section className="account-panel">
    <h1>{headings[mode]}</h1>
    {message ? <p role="status">{message}</p> : <form className="stack" onSubmit={submit}>
      {mode === "signup" && <label>Name<input name="name" autoComplete="name" required maxLength={120} /></label>}
      {mode !== "reset" && <label>Email<input name="email" type="email" autoComplete="email" required /></label>}
      {mode !== "forgot" && <label>{mode === "reset" ? "New password" : "Password"}
        <input name="password" type="password" required minLength={mode === "signin" ? 1 : 8}
          maxLength={128} autoComplete={mode === "signin" ? "current-password" : "new-password"} />
      </label>}
      {error && <p role="alert">{error}</p>}
      {mode === "signin" && <a href="/account?view=forgot">Forgot password?</a>}
      <button className="action" disabled={busy || (mode === "reset" && !token)}>{busy ? "Please wait…" : mode === "forgot" ? "Send reset link" : mode === "reset" ? "Save password" : headings[mode]}</button>
    </form>}
    <nav className="account-links" aria-label="Account options">
      {mode === "signin" ? <a href="/account?view=signup">Create an account</a> : <a href="/account">Back to sign in</a>}
      {mode === "reset" && <a href="/account?view=forgot">Request a new link</a>}
    </nav>
  </section>;
}
