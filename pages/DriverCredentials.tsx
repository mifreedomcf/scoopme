import { useEffect, useState } from "react";
import { base44, submitDriverCredential, type ApiError } from "@/lib/api";
import { Empty } from "@/components/Chrome";

interface Credential {
  id: string;
  credential_type: string;
  required_for: string;
  status: string;
  expiration_date?: string;
  document_scan_status?: string;
}

interface Profile {
  id: string;
  eligibility_status: string;
  eligibility_reason_code?: string;
  eligibility_blocking?: string[];
  approval_tier: string;
}

/** What a driver can upload themselves. Vendor checks are not on this list. */
const SELF_SUBMIT: [string, string][] = [
  ["drivers_license", "Driver's licence"],
  ["vehicle_registration", "Vehicle registration"],
  ["auto_insurance", "Auto insurance"],
  ["insurer_volunteer_acknowledgement", "Insurer's note about volunteer driving"],
  ["vehicle_inspection", "Mechanic's inspection"],
  ["cpr", "CPR certificate"],
  ["first_aid", "First aid certificate"],
  ["cdl", "CDL"],
  ["wheelchair_lift_inspection", "Wheelchair lift inspection"],
  ["securement_training", "Securement training"],
  ["car_seat_availability", "Car seat or booster"],
  ["language_certification", "Language certification"],
];

const VENDOR_CHECKS: [string, string][] = [
  ["mvr_check", "Driving record"],
  ["criminal_background_check", "Background check"],
  ["sex_offender_registry_check", "Registry check"],
  ["fingerprinting", "Fingerprinting"],
  ["child_abuse_neglect_registry", "Child abuse and neglect registry"],
];

const LABELS = new Map([...SELF_SUBMIT, ...VENDOR_CHECKS]);

function statusTone(status: string) {
  if (status === "verified") return "go";
  if (["rejected", "expired"].includes(status)) return "stop";
  if (["submitted", "pending_vendor"].includes(status)) return "live";
  return "wait";
}

function daysUntil(date?: string): number | null {
  if (!date) return null;
  const ms = new Date(`${date}T00:00:00Z`).getTime() - Date.now();
  return Math.floor(ms / 86_400_000);
}

export default function DriverCredentials() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [openType, setOpenType] = useState<string | null>(null);
  const [form, setForm] = useState({ expiration_date: "", completed_date: "", filename: "", document_reference: "" });

  const load = async () => {
    const profiles = (await base44.entities.DriverProfile.list("-created_date", 1)) as Profile[];
    setProfile(profiles[0] ?? null);
    if (profiles[0]) {
      const rows = (await base44.entities.DriverCredential.filter(
        { driver_profile_id: profiles[0].id }, "credential_type", 50,
      )) as Credential[];
      setCredentials(rows);
    }
  };

  useEffect(() => { load().catch(() => setNote("We could not load your documents. Try again in a moment.")); }, []);

  async function submit(type: string) {
    setNote(null);
    try {
      const result = await submitDriverCredential({
        credential_type: type,
        expiration_date: form.expiration_date || undefined,
        completed_date: form.completed_date || undefined,
        document_reference: form.document_reference || undefined,
        upload: form.filename
          ? { filename: form.filename, content_type: form.filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg", size_bytes: 1024 }
          : undefined,
      });
      setNote((result as { message: string }).message);
      setOpenType(null);
      setForm({ expiration_date: "", completed_date: "", filename: "", document_reference: "" });
      await load();
    } catch (err) {
      const e = err as ApiError;
      setNote(e.fields?.[0]?.message ?? e.message);
    }
  }

  const byType = new Map(credentials.map((c) => [c.credential_type, c]));
  const blocking = profile?.eligibility_blocking ?? [];

  return (
    <main id="main" className="pad">
      <h1>Your documents</h1>

      {profile && (
        <article className="record">
          <span className={`status status--${profile.eligibility_status === "eligible" ? "go" : "stop"}`}>
            {profile.eligibility_status === "eligible" ? "Ready to drive" : "Not driving yet"}
          </span>
          <h3>{profile.eligibility_status === "eligible" ? "You can be matched with rides" : "Something is missing"}</h3>
          {blocking.length > 0 ? (
            <>
              <p>These are missing, unchecked, or out of date:</p>
              <ul>{blocking.map((b) => <li key={b}>{LABELS.get(b) ?? b.replace(/_/g, " ")}</li>)}</ul>
            </>
          ) : (
            <p className="meta">
              {profile.eligibility_status === "eligible"
                ? "Everything is current. Offers appear on the Driving page."
                : "A coordinator is reviewing your application."}
            </p>
          )}
        </article>
      )}

      {note && <p role="status" className="field-error">{note}</p>}

      {!profile && <Empty title="No driver profile yet" body="Start your volunteer application first, and your documents will appear here." />}

      {profile && (
        <>
          <section aria-labelledby="yours">
            <h2 id="yours">Documents you upload</h2>
            {SELF_SUBMIT.map(([type, label]) => {
              const c = byType.get(type);
              const days = daysUntil(c?.expiration_date);
              return (
                <article className="record" key={type}>
                  <span className={`status status--${statusTone(c?.status ?? "not_started")}`}>
                    {(c?.status ?? "not started").replace(/_/g, " ")}
                  </span>
                  <h3>{label}</h3>
                  {c?.expiration_date && (
                    <p className="meta">
                      Expires {c.expiration_date}
                      {days !== null && days >= 0 && days <= 30 && ` — that is ${days} day${days === 1 ? "" : "s"} away`}
                      {days !== null && days < 0 && " — already past"}
                    </p>
                  )}
                  {c?.document_scan_status === "pending" && (
                    <p className="meta">
                      Uploaded. It stays locked until the file has been scanned, so a coordinator cannot open it yet.
                    </p>
                  )}

                  {openType === type ? (
                    <>
                      <div className="field">
                        <label htmlFor={`file-${type}`}>File name</label>
                        <span className="hint">PDF or photo, up to 10 MB.</span>
                        <input id={`file-${type}`} value={form.filename} onChange={(e) => setForm({ ...form, filename: e.target.value })} />
                      </div>
                      <div className="field">
                        <label htmlFor={`ref-${type}`}>Private upload reference</label>
                        <span className="hint">Produced by the upload step. Never a public link.</span>
                        <input id={`ref-${type}`} value={form.document_reference} onChange={(e) => setForm({ ...form, document_reference: e.target.value })} />
                      </div>
                      <div className="field">
                        <label htmlFor={`exp-${type}`}>Expiry date</label>
                        <input id={`exp-${type}`} type="date" value={form.expiration_date} onChange={(e) => setForm({ ...form, expiration_date: e.target.value })} />
                      </div>
                      <div className="actions">
                        <button className="btn btn--primary" onClick={() => submit(type)}>Save this document</button>
                        <button className="btn btn--secondary" onClick={() => setOpenType(null)}>Cancel</button>
                      </div>
                    </>
                  ) : (
                    <button className="btn btn--secondary" onClick={() => setOpenType(type)}>
                      {c ? "Replace it" : "Add it"}
                    </button>
                  )}
                </article>
              );
            })}
          </section>

          <section aria-labelledby="checks">
            <h2 id="checks">Checks a coordinator runs</h2>
            <p className="meta">
              These come from the screening vendor, not from you. There is nothing to upload.
            </p>
            {VENDOR_CHECKS.map(([type, label]) => {
              const c = byType.get(type);
              return (
                <article className="record" key={type}>
                  <span className={`status status--${statusTone(c?.status ?? "not_started")}`}>
                    {(c?.status ?? "not started").replace(/_/g, " ")}
                  </span>
                  <h3>{label}</h3>
                  {c?.expiration_date && <p className="meta">Valid until {c.expiration_date}</p>}
                </article>
              );
            })}
          </section>

          <p className="footnote">
            Replacing a document clears its previous approval, so a coordinator checks the new one. If any
            required document runs out, your ride offers pause automatically that morning — you do not need
            to do anything, and nothing you have already agreed to is affected.
          </p>
        </>
      )}
    </main>
  );
}
