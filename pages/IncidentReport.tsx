import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { reportSafetyIncident, type ApiError, type AppConfig } from "@/lib/api";
import { ErrorSummary } from "@/components/Chrome";

const TYPES: [string, string][] = [
  ["crash", "A crash"],
  ["injury", "Someone was hurt"],
  ["missing_rider", "I can't find the rider"],
  ["failed_handoff", "The drop-off couldn't be completed"],
  ["harassment", "Harassment"],
  ["discrimination", "Discrimination"],
  ["suspected_abuse_neglect", "I'm worried about abuse or neglect"],
  ["inappropriate_conduct", "Someone behaved inappropriately"],
  ["vehicle_issue", "A problem with the vehicle"],
  ["other", "Something else"],
];

export default function IncidentReport({ config }: { config: AppConfig | null }) {
  const [params] = useSearchParams();
  const rideId = params.get("ride") ?? "";
  const [form, setForm] = useState({
    incident_type: "",
    narrative: "",
    immediate_actions_taken: "",
    emergency_services_contacted: false,
  });
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [result, setResult] = useState<{ incident_id: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    setErrors([]);
    try {
      const r = await reportSafetyIncident({
        ride_request_id: rideId || undefined,
        incident_type: form.incident_type,
        narrative: form.narrative,
        immediate_actions_taken: form.immediate_actions_taken,
        emergency_services_contacted: form.emergency_services_contacted,
      });
      setResult(r as unknown as { incident_id: string; message: string });
    } catch (err) {
      const e = err as ApiError;
      setErrors(e.fields?.length ? e.fields : [{ field: "incident_type", message: e.message }]);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <main id="main" className="pad">
        <h1>Thank you for telling us</h1>
        <p>{result.message}</p>
        <div className="emergency">
          <h3>If anyone is in danger right now</h3>
          <a className="btn btn--danger" href="tel:911">Call 911</a>
          {config?.support.safety_phone && (
            <a className="btn btn--secondary btn--block" href={`tel:${config.support.safety_phone}`}>
              Call the safety team
            </a>
          )}
        </div>
        <p className="meta">Reference: {result.incident_id}</p>
      </main>
    );
  }

  return (
    <main id="main" className="pad">
      <h1>Report a safety concern</h1>

      <div className="emergency">
        <h3>First, is anyone in danger or hurt?</h3>
        <a className="btn btn--danger" href="tel:911">Call 911</a>
        <p className="meta">
          This form does not contact emergency services and nobody reads it instantly. Call first, then tell
          us.
        </p>
      </div>

      <ErrorSummary errors={errors} />

      <div className="field">
        <label htmlFor="field-incident_type">What happened?</label>
        <select
          id="field-incident_type"
          value={form.incident_type}
          onChange={(e) => setForm({ ...form, incident_type: e.target.value })}
        >
          <option value="">Choose one</option>
          {TYPES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      <div className="field">
        <label htmlFor="field-narrative">Tell us in your own words</label>
        <span className="hint">
          Whatever you remember. You do not have to be sure about anything, and you will not get in trouble
          for reporting something that turns out to be nothing.
        </span>
        <textarea
          id="field-narrative"
          value={form.narrative}
          onChange={(e) => setForm({ ...form, narrative: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="field-actions">What did you do at the time? (optional)</label>
        <textarea
          id="field-actions"
          value={form.immediate_actions_taken}
          onChange={(e) => setForm({ ...form, immediate_actions_taken: e.target.value })}
        />
      </div>

      <div className="check">
        <input
          id="field-emergency"
          type="checkbox"
          checked={form.emergency_services_contacted}
          onChange={(e) => setForm({ ...form, emergency_services_contacted: e.target.checked })}
        />
        <label htmlFor="field-emergency">I already called 911 or another emergency service</label>
      </div>

      <div className="actions">
        <button className="btn btn--primary btn--block" onClick={send} disabled={busy || !form.incident_type}>
          {busy ? "Sending…" : "Send this to the safety team"}
        </button>
      </div>

      <p className="footnote">
        What you write here is read only by the safety team. It never appears in reports, exports, or
        anyone else&apos;s view of the ride, and once you send it the record cannot be deleted while it is
        being looked into.
      </p>
    </main>
  );
}
