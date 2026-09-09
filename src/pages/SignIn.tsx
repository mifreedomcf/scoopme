import { useState } from "react";
import { base44 } from "@/lib/api";

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await base44.auth.loginViaEmailPassword(email, password);
      window.location.assign("/rides");
    } catch {
      // Deliberately identical wording whether the account exists or not.
      setError("That email and password did not match. Check both and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="pad">
      <h1>Sign in</h1>
      <p>Rides are free, and you never need a payment method to ask for one.</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="field">
        <label htmlFor="field-email">Email</label>
        <input id="field-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="field-password">Password</label>
        <input id="field-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <button className="btn btn--primary btn--block" onClick={signIn} disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <div className="actions">
        <button className="btn btn--secondary btn--block" onClick={() => base44.auth.loginWithProvider("google")}>
          Continue with Google
        </button>
      </div>
    </main>
  );
}
