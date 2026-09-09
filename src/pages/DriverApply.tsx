import { useEffect, useRef, useState } from "react";
import { ApiError, base44, submitDriverApplication, type ApiFieldError, type AppConfig } from "@/lib/api";
import { ErrorSummary } from "@/components/Chrome";

interface Application extends Record<string, unknown> { id: string; status: string }

const ACKS: [string, string][] = [
  ["policy_zero_tolerance_accepted", "I accept the zero-tolerance drug and alcohol policy."],
  ["policy_nondiscrimination_accepted", "I accept the nondiscrimination and accommodation policy."],
  ["training_safe_driving_ack", "I have read the safe-driving guidance."],
  ["training_boundaries_ack", "I have read the boundaries and conduct guidance."],
  ["training_mandated_reporting_ack", "I understand my mandated-reporting duties."],
  ["training_incident_response_ack", "I have read the incident-response guidance."],
  ["training_rider_assistance_ack", "I have read the rider-assistance guidance."],
  ["training_privacy_ack", "I have read the privacy guidance."],
];

export default function DriverApply({ config }: { config: AppConfig | null }) {
  const [app, setApp] = useState<Application | null>(null);
  const [errors, setErrors] = useState<ApiFieldError[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      const me = await base44.auth.me();
      if (!me) return;
      const rows = (await base44.entities.DriverApplication.list("-created_date", 1)) as Application[];
      if (rows.length > 0) { setApp(rows[0]); return; }
      const created = (await base44.entities.DriverApplication.create({
        user_id: (me as { id: string }).id,
        applicant_email: (me as { email: string }).email,
        status: "draft",
        current_step: 1,
      })) as Application;
      setApp(created);
    })().catch(() => setNote("We could not open your application. Sign in and try again."));
  }, []);

  /** Autosave: the draft is written on a short debounce, so nothing is lost. */
  function patch(changes: Record<string, unknown>) {
    if (!app) return;
    setApp({ ...app, ...changes });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      base44.entities.DriverApplication.update(app.id, changes)
        .then(() => setNote("Saved"))
        .catch(() => setNote("We could not save that just now. Your answers are still on screen."));
    }, 600);
  }

  async function submit() {
    if (!app) return;
    setErrors([]);
    try {
      const result = await submitDriverApplication(app.id);
      setNote((result as { message: string }).message);
      setApp({ ...app, status: "checks_pending" });
    } catch (err) {
      const e = err as ApiError;
      setErrors(e.fields ?? []);
      setNote(e.message);
    }
  }

  if (!app) return <main id="main" className="pad"><h1>Volunteer to drive</h1><p>{note ?? "Loading…"}</p></main>;

  const value = (k: string) => String(app[k] ?? "");
  const checked = (k: string) => Boolean(app[k]);

  return (
    <main id="main" className="pad">
      <h1>Volunteer to drive</h1>
      <p>
        Neighbours getting to food, supplies, and appointments. You choose your own hours, and nobody is ever
        charged for a ride.
      </p>
      <p className="meta" role="status">{note}</p>

      <ErrorSummary errors={errors.map((e) => ({ field: e.field, message: e.message }))} />

      <section aria-labelledby="about-you">
        <h2 id="about-you">About you</h2>
        <div className="field">
          <label htmlFor="field-legal_first_name">Legal first name</label>
          <input id="field-legal_first_name" value={value("legal_first_name")} onChange={(e) => patch({ legal_first_name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="field-legal_last_name">Legal last name</label>
          <input id="field-legal_last_name" value={value("legal_last_name")} onChange={(e) => patch({ legal_last_name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="field-date_of_birth">Date of birth</label>
          <span className="hint">
            Used only to check you meet the minimum age of {config?.pilot ? "" : ""}
            {/* minimum age is enforced on the server against current settings */}
            the program.
          </span>
          <input id="field-date_of_birth" type="date" value={value("date_of_birth")} onChange={(e) => patch({ date_of_birth: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="field-phone">Phone</label>
          <input id="field-phone" type="tel" value={value("phone")} onChange={(e) => patch({ phone: e.target.value })} />
        </div>
      </section>

      <section aria-labelledby="licence">
        <h2 id="licence">Your licence</h2>
        <p className="meta">
          We store the issuing state, the expiry date, and the last four digits. We never store your full
          licence number or a Social Security number.
        </p>
        <div className="field">
          <label htmlFor="field-license_issuing_state">Issuing state</label>
          <input id="field-license_issuing_state" maxLength={2} value={value("license_issuing_state")} onChange={(e) => patch({ license_issuing_state: e.target.value.toUpperCase() })} />
        </div>
        <div className="field">
          <label htmlFor="field-license_expiration">Expiry date</label>
          <input id="field-license_expiration" type="date" value={value("license_expiration")} onChange={(e) => patch({ license_expiration: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="field-license_number_last4">Last four digits</label>
          <input id="field-license_number_last4" maxLength={4} inputMode="numeric" value={value("license_number_last4")} onChange={(e) => patch({ license_number_last4: e.target.value })} />
        </div>
      </section>

      <section aria-labelledby="checks">
        <h2 id="checks">Screening</h2>
        <p>
          Every volunteer goes through identity verification, a motor-vehicle-record check, a criminal
          background check, and a National Sex Offender Registry check, repeated at least once a year. Your
          eligibility pauses automatically the moment any document or check expires.
        </p>
        <div className="check">
          <input id="field-applying_for_minor_transport" type="checkbox" checked={checked("applying_for_minor_transport")} onChange={(e) => patch({ applying_for_minor_transport: e.target.checked })} />
          <label htmlFor="field-applying_for_minor_transport">
            I want to be considered for transporting under-18 riders later. This needs extra screening and is
            not active in this pilot.
          </label>
        </div>
      </section>

      <section aria-labelledby="acks">
        <h2 id="acks">Policies and training</h2>
        {ACKS.map(([key, label]) => (
          <div className="check" key={key}>
            <input id={`field-${key}`} type="checkbox" checked={checked(key)} onChange={(e) => patch({ [key]: e.target.checked })} />
            <label htmlFor={`field-${key}`}>{label}</label>
          </div>
        ))}
        {checked("applying_for_minor_transport") && (
          <div className="check">
            <input id="field-training_minor_handoff_ack" type="checkbox" checked={checked("training_minor_handoff_ack")} onChange={(e) => patch({ training_minor_handoff_ack: e.target.checked })} />
            <label htmlFor="field-training_minor_handoff_ack">I have read the minor pickup and handoff policy.</label>
          </div>
        )}
      </section>

      <div className="actions">
        <button className="btn btn--primary" onClick={submit} disabled={app.status !== "draft" && app.status !== "documents_pending"}>
          {app.status === "draft" || app.status === "documents_pending" ? "Send my application" : "Already sent"}
        </button>
      </div>
      <p className="footnote">
        Volunteering does not make you an employee, contractor, or agent, and nothing here promises work,
        hours, or income. A coordinator, never you, decides your approval.
      </p>
    </main>
  );
}
