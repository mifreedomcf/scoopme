import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  base44, manageDependentProfile, revokeConsent, signMinorConsent,
  type ApiError, type AppConfig,
} from "@/lib/api";
import { Empty } from "@/components/Chrome";

interface Dependent {
  id: string; first_name?: string; last_initial?: string;
  date_of_birth?: string; height_inches?: number; active: boolean;
}
interface Relationship {
  id: string; dependent_profile_id: string; authority_type: string;
  status: string; expires_on?: string;
}
interface Consent {
  id: string; dependent_profile_id: string; ride_request_id?: string;
  scope: string; status: string; document_version: string; expires_on?: string;
}
interface Adult {
  id: string; dependent_profile_id: string; name: string;
  relationship: string; role: string; active: boolean;
}

const RESTRAINT_LABELS: Record<string, string> = {
  rear_facing_car_seat: "a rear-facing car seat",
  forward_facing_car_seat: "a forward-facing car seat with a harness",
  booster_seat: "a booster seat",
  seat_belt: "a lap-and-shoulder belt",
};

export default function GuardianDashboard({ config }: { config: AppConfig | null }) {
  const [dependents, setDependents] = useState<Dependent[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [consents, setConsents] = useState<Consent[]>([]);
  const [adults, setAdults] = useState<Adult[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [restraint, setRestraint] = useState<{ required: string; reason: string; reviewed: boolean } | null>(null);
  const [child, setChild] = useState({ first_name: "", last_initial: "", date_of_birth: "", height_inches: "" });
  const [adult, setAdult] = useState({ dependent_profile_id: "", name: "", relationship: "", phone: "", role: "both" });

  const enabled = Boolean(config?.flags.minor_rides_enabled);

  const load = async () => {
    if (!enabled) return;
    setDependents((await base44.entities.DependentProfile.list("-created_date", 20)) as Dependent[]);
    setRelationships((await base44.entities.GuardianRelationship.list("-created_date", 20)) as Relationship[]);
    setConsents((await base44.entities.ConsentRecord.list("-created_date", 50)) as Consent[]);
    setAdults((await base44.entities.AuthorizedAdult.list("-created_date", 50)) as Adult[]);
  };

  useEffect(() => { load().catch(() => setNote("We could not load this page.")); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [enabled]);

  async function saveChild() {
    setNote(null);
    try {
      const r = await manageDependentProfile({
        action: "save_child",
        first_name: child.first_name,
        last_initial: child.last_initial,
        date_of_birth: child.date_of_birth,
        height_inches: child.height_inches ? Number(child.height_inches) : undefined,
      });
      const res = r as { required_restraint: string; restraint_reason: string; restraint_policy_reviewed: boolean; notice?: string };
      setRestraint({ required: res.required_restraint, reason: res.restraint_reason, reviewed: res.restraint_policy_reviewed });
      setNote(res.notice ?? "Saved. A coordinator has to verify that you are this child's parent or legal guardian before anything can be booked.");
      setChild({ first_name: "", last_initial: "", date_of_birth: "", height_inches: "" });
      await load();
    } catch (err) {
      const e = err as ApiError;
      setNote(e.fields?.map((f) => f.message).join(" ") ?? e.message);
    }
  }

  async function addAdult() {
    setNote(null);
    try {
      const r = await manageDependentProfile({ action: "add_authorized_adult", ...adult });
      setNote((r as { note: string }).note);
      setAdult({ dependent_profile_id: "", name: "", relationship: "", phone: "", role: "both" });
      await load();
    } catch (err) {
      setNote((err as ApiError).message);
    }
  }

  async function sign(consentId: string, relationshipLabel: string) {
    setNote(null);
    try {
      const r = await signMinorConsent({
        consent_record_id: consentId,
        acknowledged: true,
        signer_relationship: relationshipLabel,
        emergency_authorization_given: true,
      });
      setNote((r as { message: string }).message);
      await load();
    } catch (err) {
      setNote((err as ApiError).message);
    }
  }

  async function withdraw(consentId: string) {
    setNote(null);
    try {
      const r = await revokeConsent(consentId);
      setNote((r as { message: string }).message);
      await load();
    } catch (err) {
      setNote((err as ApiError).message);
    }
  }

  if (!enabled) {
    return (
      <main id="main" className="pad">
        <h1>Rides for children</h1>
        <div className="band band--stop" role="status" style={{ margin: "1rem 0" }}>
          Not available. Rides for under-18s are switched off.
        </div>
        <p>
          We are not carrying children yet. Before we do, an attorney and an insurer have to sign off on the
          safeguarding policy, the consent wording, the child restraint rules, and abuse and molestation
          cover — and every driver who could carry a child needs fingerprinting and a child abuse and
          neglect registry check on top of their ordinary screening.
        </p>
        <p>
          Until all of that is done, this part of the service stays off. Adults can book rides for themselves
          in the meantime.
        </p>
        <Link className="btn btn--primary" to="/rides">Book a ride for yourself</Link>
      </main>
    );
  }

  const relationshipFor = (dependentId: string) => relationships.find((r) => r.dependent_profile_id === dependentId);
  const pendingConsents = consents.filter((c) => c.status === "requested");
  const liveConsents = consents.filter((c) => c.status === "signed");

  return (
    <main id="main" className="pad">
      <h1>Your children&apos;s rides</h1>
      {note && <p role="status" className="field-error">{note}</p>}

      {pendingConsents.length > 0 && (
        <section aria-labelledby="to-sign">
          <h2 id="to-sign">Waiting for your signature</h2>
          <p>Nothing is booked and no driver can see this trip until you sign.</p>
          {pendingConsents.map((c) => {
            const rel = relationshipFor(c.dependent_profile_id);
            return (
              <article className="record" key={c.id}>
                <span className="status status--wait">needs your signature</span>
                <h3>{c.scope === "standing" ? "A standing arrangement" : "One trip"}</h3>
                <p className="meta">Wording version {c.document_version}</p>
                <p>
                  <Link to="/policies">Read the wording</Link> before you sign. If it has changed since last
                  time, you will be asked to read the new version.
                </p>
                <button className="btn btn--primary" onClick={() => sign(c.id, rel?.authority_type ?? "parent")}>
                  I have read it and I agree
                </button>
              </article>
            );
          })}
        </section>
      )}

      <section aria-labelledby="children">
        <h2 id="children">Children</h2>
        {dependents.length === 0 && (
          <Empty title="Nobody added yet" body="Add a child below. A coordinator then verifies that you are their parent or legal guardian." />
        )}
        {dependents.map((d) => {
          const rel = relationshipFor(d.id);
          const theirAdults = adults.filter((a) => a.dependent_profile_id === d.id && a.active);
          return (
            <article className="record" key={d.id}>
              <span className={`status status--${rel?.status === "verified" ? "go" : "wait"}`}>
                {rel?.status === "verified" ? "you are verified as their guardian" : "waiting on verification"}
              </span>
              <h3>{d.first_name} {d.last_initial}</h3>
              {rel?.status !== "verified" && (
                <p className="meta">
                  A coordinator has to check your paperwork before any trip can be booked. Saying you are
                  their parent is not enough on its own, deliberately.
                </p>
              )}
              <h4>Who can drop off and collect</h4>
              {theirAdults.length === 0 && <p className="meta">Nobody added yet.</p>}
              <ul>
                {theirAdults.map((a) => (
                  <li key={a.id}>{a.name} — {a.relationship} ({a.role})</li>
                ))}
              </ul>
              <p className="meta">
                Each trip has its own code. The person collecting reads it to the driver. The driver never
                sees it, and it is never used twice.
              </p>
            </article>
          );
        })}
      </section>

      {liveConsents.length > 0 && (
        <section aria-labelledby="live">
          <h2 id="live">Consent you have given</h2>
          {liveConsents.map((c) => (
            <article className="record" key={c.id}>
              <span className="status status--go">signed</span>
              <h3>{c.scope === "standing" ? "Standing arrangement" : "One trip"}</h3>
              <p className="meta">
                Version {c.document_version}
                {c.expires_on && ` · until ${c.expires_on}`}
              </p>
              <button className="btn btn--secondary" onClick={() => withdraw(c.id)}>
                Withdraw this
              </button>
              <p className="meta">
                You do not need to give a reason, and any trip that has not started will be stopped.
              </p>
            </article>
          ))}
        </section>
      )}

      <section aria-labelledby="add-child">
        <h2 id="add-child">Add a child</h2>
        <p className="meta">
          We ask for a date of birth because it decides which car seat the law requires, and a height only
          where it changes that answer. We do not ask about school, health, or why the trip is needed.
        </p>
        <div className="field">
          <label htmlFor="c-first">First name</label>
          <input id="c-first" value={child.first_name} onChange={(e) => setChild({ ...child, first_name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="c-last">Last initial</label>
          <input id="c-last" maxLength={1} value={child.last_initial} onChange={(e) => setChild({ ...child, last_initial: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="c-dob">Date of birth</label>
          <input id="c-dob" type="date" value={child.date_of_birth} onChange={(e) => setChild({ ...child, date_of_birth: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="c-height">Height in inches (optional)</label>
          <span className="hint">Only matters between 5 and 8 years old, where 4&apos;9&quot; lifts the booster requirement.</span>
          <input id="c-height" type="number" value={child.height_inches} onChange={(e) => setChild({ ...child, height_inches: e.target.value })} />
        </div>
        <button className="btn btn--primary" onClick={saveChild} disabled={!child.date_of_birth}>Save</button>

        {restraint && (
          <article className="record">
            <h3>What this child needs in the car</h3>
            <p><strong>{RESTRAINT_LABELS[restraint.required] ?? restraint.required}</strong></p>
            <p className="meta">{restraint.reason}</p>
            {!restraint.reviewed && (
              <p className="field-error">
                DRAFT — REQUIRES LEGAL REVIEW. These car seat rules have not been checked against Michigan
                law by an attorney yet, so no trip can be booked on them.
              </p>
            )}
          </article>
        )}
      </section>

      {dependents.length > 0 && (
        <section aria-labelledby="add-adult">
          <h2 id="add-adult">Add someone who can drop off or collect</h2>
          <div className="field">
            <label htmlFor="a-child">Which child?</label>
            <select id="a-child" value={adult.dependent_profile_id} onChange={(e) => setAdult({ ...adult, dependent_profile_id: e.target.value })}>
              <option value="">Choose one</option>
              {dependents.map((d) => <option key={d.id} value={d.id}>{d.first_name} {d.last_initial}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="a-name">Their name</label>
            <input id="a-name" value={adult.name} onChange={(e) => setAdult({ ...adult, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="a-rel">Relationship to the child</label>
            <input id="a-rel" value={adult.relationship} onChange={(e) => setAdult({ ...adult, relationship: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="a-phone">Phone</label>
            <input id="a-phone" type="tel" value={adult.phone} onChange={(e) => setAdult({ ...adult, phone: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="a-role">They can</label>
            <select id="a-role" value={adult.role} onChange={(e) => setAdult({ ...adult, role: e.target.value })}>
              <option value="both">Drop off and collect</option>
              <option value="pickup">Drop off only</option>
              <option value="dropoff">Collect only</option>
            </select>
          </div>
          <button className="btn btn--primary" onClick={addAdult} disabled={!adult.dependent_profile_id || !adult.name}>
            Add them
          </button>
        </section>
      )}

      <p className="footnote">
        A child is never left on their own and is never handed to someone who is not on this list. If a
        handoff cannot be completed, the driver stops where they are, stays with the child, and calls our
        safety line. They do not choose somewhere else to go.
      </p>
    </main>
  );
}
