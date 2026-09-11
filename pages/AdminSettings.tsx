import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { base44, updateConfig, updateLaunchGate, type AppConfig } from "@/lib/api";

interface Gate {
  id: string;
  gate_key: string;
  category: string;
  title: string;
  description?: string;
  status: string;
  owner_email?: string;
  evidence_url?: string;
  reviewer_email?: string;
  expires_date?: string;
  gates_flags?: string[];
  is_mandatory?: boolean;
}

const FLAGS = [
  ["ride_fulfillment_enabled", "Drive real rides"],
  ["adult_rides_enabled", "Accept adult ride requests"],
  ["minor_rides_enabled", "Rides for people under 18"],
  ["same_day_rides_enabled", "Same-day requests"],
  ["live_location_enabled", "Live location during a ride"],
  ["platform_donations_enabled", "Donations to the platform"],
  ["direct_driver_tips_enabled", "Direct driver tips"],
  ["organization_in_kind_contributions_enabled", "Organization pledges of hours or supplies"],
] as const;

export default function AdminSettings({ config, reload }: { config: AppConfig | null; reload: () => void }) {
  const [gates, setGates] = useState<Gate[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [operator, setOperator] = useState(config?.operator_legal_name ?? "");
  const [supportPhone, setSupportPhone] = useState(config?.support.phone ?? "");
  const [safetyPhone, setSafetyPhone] = useState(config?.support.safety_phone ?? "");
  const [justification, setJustification] = useState("");

  useEffect(() => {
    base44.entities.LaunchGate.list("category", 100).then((rows) => setGates(rows as Gate[])).catch(() => setGates([]));
  }, []);

  async function saveIdentity() {
    try {
      await updateConfig({ operator_legal_name: operator, support_phone: supportPhone, safety_phone: safetyPhone });
      setNote("Saved.");
      reload();
    } catch (e) { setNote((e as Error).message); }
  }

  async function toggleFlag(flag: string, value: boolean) {
    try {
      const result = await updateConfig(
        { [flag]: value },
        justification ? { justification, reauthenticated: true } : undefined,
      );
      const rejected = (result as { rejected?: { message: string }[] }).rejected ?? [];
      setNote(rejected.length > 0 ? rejected.map((r) => r.message).join(" ") : "Setting changed.");
      reload();
    } catch (e) { setNote((e as Error).message); }
  }

  async function saveGate(gate: Gate, changes: Record<string, unknown>) {
    try {
      await updateLaunchGate(gate.gate_key, changes);
      setNote(`Updated: ${gate.title}`);
      setGates((g) => g.map((x) => (x.id === gate.id ? { ...x, ...changes } as Gate : x)));
    } catch (e) { setNote((e as Error).message); }
  }

  const complete = gates.filter((g) => g.status === "complete").length;

  return (
    <main id="main" className="pad">
      <h1>Admin settings</h1>
      {note && <p role="status" className="field-error">{note}</p>}

      <nav aria-label="Admin pages" className="actions">
        <Link className="btn btn--secondary" to="/reports">Numbers and exports</Link>
        <Link className="btn btn--secondary" to="/safety">Safety incidents</Link>
      </nav>

      <section aria-labelledby="identity">
        <h2 id="identity">Who runs this service</h2>
        <div className="field">
          <label htmlFor="field-operator">Legal operator name</label>
          <span className="hint">
            Shown on every public page. Nobody is named as operator, carrier, insurer, employer, agent, or
            guarantor until you type it here.
          </span>
          <input id="field-operator" value={operator} onChange={(e) => setOperator(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="field-support-phone">Support phone</label>
          <input id="field-support-phone" type="tel" value={supportPhone} onChange={(e) => setSupportPhone(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="field-safety-phone">Safety team phone</label>
          <span className="hint">Separate from 911. Shown on every active ride.</span>
          <input id="field-safety-phone" type="tel" value={safetyPhone} onChange={(e) => setSafetyPhone(e.target.value)} />
        </div>
        <button className="btn btn--primary" onClick={saveIdentity}>Save changes</button>
      </section>

      <section aria-labelledby="flags">
        <h2 id="flags">What is switched on</h2>
        <p className="meta">
          These are enforced on the server. Turning something on is refused unless the launch checklist below
          allows it.
        </p>
        {FLAGS.map(([flag, label]) => (
          <div className="check" key={flag}>
            <input
              id={`flag-${flag}`}
              type="checkbox"
              checked={Boolean(config?.flags[flag])}
              onChange={(e) => toggleFlag(flag, e.target.checked)}
            />
            <label htmlFor={`flag-${flag}`}>{label}</label>
          </div>
        ))}
        <div className="field">
          <label htmlFor="field-justification">Emergency override justification</label>
          <span className="hint">
            Only some gates can be overridden, never background checks, safeguarding, restraints, or insurance.
            Write at least 40 characters explaining why.
          </span>
          <textarea id="field-justification" value={justification} onChange={(e) => setJustification(e.target.value)} />
        </div>
      </section>

      <section aria-labelledby="retention">
        <h2 id="retention">Keeping and deleting data</h2>
        <p className="meta">
          The nightly job does nothing until you turn it on, and it should stay off until someone has
          actually read the retention schedule and decided the numbers are right. It never touches audit
          records, safety incidents, or consent, and it skips anything under a hold. If it cannot read the
          hold table, it deletes nothing at all.
        </p>
        <div className="check">
          <input
            id="flag-retention_sweep_enabled"
            type="checkbox"
            checked={Boolean((config as unknown as { flags?: Record<string, boolean> })?.flags?.retention_sweep_enabled)}
            onChange={(e) => toggleFlag("retention_sweep_enabled", e.target.checked)}
          />
          <label htmlFor="flag-retention_sweep_enabled">Run the nightly deletion and anonymization job</label>
        </div>
        <p className="meta">
          Defaults: precise location 7 days, tracking links 30, messages 180, notifications 90, rides
          anonymized at 730, handoffs anonymized at 365. Override them in the retention schedule once the
          privacy review sets them deliberately.
        </p>
      </section>

      <section aria-labelledby="gates">
        <h2 id="gates">Launch checklist ({complete} of {gates.length} complete)</h2>
        {gates.map((gate) => (
          <article className="record" key={gate.id}>
            <span className={`status status--${gate.status === "complete" ? "go" : "wait"}`}>
              {gate.status.replace(/_/g, " ")}
            </span>
            <h3>{gate.title}</h3>
            <p className="meta">{gate.description}</p>
            <p className="meta">Blocks: {(gate.gates_flags ?? []).join(", ") || "nothing"}</p>
            <div className="field">
              <label htmlFor={`evidence-${gate.id}`}>Evidence link</label>
              <input
                id={`evidence-${gate.id}`}
                defaultValue={gate.evidence_url ?? ""}
                onBlur={(e) => saveGate(gate, { evidence_url: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={`reviewer-${gate.id}`}>Reviewer email</label>
              <span className="hint">Must be someone other than you.</span>
              <input
                id={`reviewer-${gate.id}`}
                type="email"
                defaultValue={gate.reviewer_email ?? ""}
                onBlur={(e) => saveGate(gate, { reviewer_email: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={`expires-${gate.id}`}>Expires</label>
              <input
                id={`expires-${gate.id}`}
                type="date"
                defaultValue={gate.expires_date ?? ""}
                onBlur={(e) => saveGate(gate, { expires_date: e.target.value })}
              />
            </div>
            <div className="actions">
              <button className="btn btn--primary" onClick={() => saveGate(gate, { status: "complete" })}>
                Mark complete
              </button>
              <button className="btn btn--secondary" onClick={() => saveGate(gate, { status: "in_progress" })}>
                Mark in progress
              </button>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
