import { useEffect, useState } from "react";
import {
  base44, recordContributionFulfillment, submitContributionPledge,
  type ApiError, type AppConfig,
} from "@/lib/api";
import { Empty } from "@/components/Chrome";

interface CatalogItem {
  id: string; kind: string; title: string; description?: string;
  unit_label: string; target_quantity?: number; active: boolean;
}

interface Pledge {
  id: string; catalog_item_id: string; kind: string; quantity: number;
  unit_label: string; status: string; ends_on?: string; organization_id: string;
}

interface Member { organization_id: string; status: string }

const KIND_LABELS: Record<string, string> = {
  volunteer_hours: "Volunteer hours",
  supplies: "Supplies",
  equipment: "Equipment",
  space: "Space",
  services: "Services",
};

export default function Contributions({ config }: { config: AppConfig | null }) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [pledges, setPledges] = useState<Pledge[]>([]);
  const [orgId, setOrgId] = useState("");
  const [form, setForm] = useState({ catalog_item_id: "", quantity: "", note: "", ends_on: "" });
  const [record, setRecord] = useState({ pledge_id: "", quantity: "", occurred_on: "", description: "" });
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const load = async () => {
    setItems((await base44.entities.ContributionCatalogItem.filter({ active: true }, "display_order", 50)) as CatalogItem[]);
    try {
      setPledges((await base44.entities.ContributionPledge.list("-created_date", 50)) as Pledge[]);
      const members = (await base44.entities.OrganizationMember.list("-created_date", 10)) as Member[];
      setOrgId(members.find((m) => m.status === "approved")?.organization_id ?? "");
    } catch {
      setPledges([]);
    }
  };

  useEffect(() => { load().catch(() => setNote("We could not load this page.")); }, []);

  async function pledge() {
    setErrors([]);
    setNote(null);
    try {
      const r = await submitContributionPledge({
        organization_id: orgId,
        catalog_item_id: form.catalog_item_id,
        quantity: Number(form.quantity),
        note: form.note || undefined,
        ends_on: form.ends_on || undefined,
      });
      const res = r as { unconditional_notice: string; warnings: string[] };
      setNote([...(res.warnings ?? []), res.unconditional_notice].join(" "));
      setForm({ catalog_item_id: "", quantity: "", note: "", ends_on: "" });
      await load();
    } catch (err) {
      const e = err as ApiError;
      setErrors(e.fields?.length ? e.fields : [{ field: "quantity", message: e.message }]);
    }
  }

  async function logDelivery() {
    setNote(null);
    try {
      const r = await recordContributionFulfillment({
        pledge_id: record.pledge_id,
        quantity: Number(record.quantity),
        occurred_on: record.occurred_on || undefined,
        description: record.description || undefined,
      });
      const res = r as { fulfilled: number; outstanding: number; consequences_of_shortfall: string; unit_label?: string };
      setNote(`Recorded. ${res.fulfilled} logged so far, ${res.outstanding} still to come. ${res.consequences_of_shortfall}`);
      setRecord({ pledge_id: "", quantity: "", occurred_on: "", description: "" });
      await load();
    } catch (err) {
      setNote((err as ApiError).message);
    }
  }

  const enabled = Boolean(config?.flags.organization_in_kind_contributions_enabled);
  const acceptedPledges = pledges.filter((p) => ["accepted", "partially_fulfilled"].includes(p.status));

  return (
    <main id="main" className="pad">
      <h1>Hours and supplies</h1>

      <div className="free-rule">
        <strong>This changes nothing about who gets a ride.</strong>
        <span>
          Rides are free and unconditional. Nothing your organization gives affects any participant&apos;s
          eligibility, priority, matching, or service. No participant is ever asked to work or contribute in
          exchange for their own ride, and a pledge that does not come through creates no debt, penalty, or
          restriction of any kind.
        </span>
      </div>

      {note && <p role="status">{note}</p>}
      {errors.length > 0 && (
        <div className="error-summary" role="alert">
          <h3>This needs a change</h3>
          <ul>{errors.map((e) => <li key={e.field}>{e.message}</li>)}</ul>
        </div>
      )}

      <section aria-labelledby="needs">
        <h2 id="needs">What would help right now</h2>
        {items.length === 0 && (
          <Empty title="Nothing listed" body="A coordinator publishes what is actually needed here. Nothing is asked for until then." />
        )}
        {items.map((i) => (
          <article className="record" key={i.id}>
            <span className="status status--wait">{KIND_LABELS[i.kind] ?? i.kind}</span>
            <h3>{i.title}</h3>
            {i.description && <p>{i.description}</p>}
            {i.target_quantity !== undefined && (
              <p className="meta">
                Hoping for about {i.target_quantity} {i.unit_label}. That is a hope, not an amount anyone owes.
              </p>
            )}
          </article>
        ))}
      </section>

      {enabled && orgId && (
        <section aria-labelledby="offer">
          <h2 id="offer">Offer something</h2>
          <div className="field">
            <label htmlFor="p-item">What can you offer?</label>
            <select id="p-item" value={form.catalog_item_id} onChange={(e) => setForm({ ...form, catalog_item_id: e.target.value })}>
              <option value="">Choose one</option>
              {items.map((i) => <option key={i.id} value={i.id}>{i.title} ({i.unit_label})</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="p-qty">How much?</label>
            <input id="p-qty" type="number" min={1} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="p-ends">By when? (optional)</label>
            <input id="p-ends" type="date" value={form.ends_on} onChange={(e) => setForm({ ...form, ends_on: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="p-note">Anything we should know? (optional)</label>
            <span className="hint">
              Practical details only. A pledge cannot be tied to a participant getting a ride, so please do
              not word it that way — we will ask you to change it.
            </span>
            <textarea id="p-note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
          <button className="btn btn--primary" onClick={pledge} disabled={!form.catalog_item_id || !form.quantity}>
            Offer this
          </button>
          <p className="meta">
            We cannot tell you whether this is tax deductible. Ask your own adviser.
          </p>
        </section>
      )}

      {!enabled && (
        <p className="field-error">
          Pledges are switched off right now. This has no effect on anyone&apos;s rides.
        </p>
      )}

      <section aria-labelledby="your-pledges">
        <h2 id="your-pledges">What you have offered</h2>
        {pledges.length === 0 && <Empty title="Nothing yet" body="Offers you make show up here with what has arrived so far." />}
        {pledges.map((p) => (
          <article className="record" key={p.id}>
            <span className={`status status--${p.status === "fulfilled" ? "go" : "wait"}`}>
              {p.status.replace(/_/g, " ")}
            </span>
            <h3>{p.quantity} {p.unit_label}</h3>
            <p className="meta">
              {KIND_LABELS[p.kind] ?? p.kind}
              {p.ends_on && ` · by ${p.ends_on}`}
            </p>
            {p.status === "lapsed" && (
              <p className="meta">
                This window closed short. Nothing follows from that — no debt, no penalty, and no effect on
                anyone&apos;s rides.
              </p>
            )}
          </article>
        ))}
      </section>

      {acceptedPledges.length > 0 && (
        <section aria-labelledby="log">
          <h2 id="log">Log what you delivered</h2>
          <div className="field">
            <label htmlFor="f-pledge">Which offer?</label>
            <select id="f-pledge" value={record.pledge_id} onChange={(e) => setRecord({ ...record, pledge_id: e.target.value })}>
              <option value="">Choose one</option>
              {acceptedPledges.map((p) => (
                <option key={p.id} value={p.id}>{p.quantity} {p.unit_label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-qty">How much arrived?</label>
            <input id="f-qty" type="number" min={1} value={record.quantity} onChange={(e) => setRecord({ ...record, quantity: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="f-date">When?</label>
            <input id="f-date" type="date" value={record.occurred_on} onChange={(e) => setRecord({ ...record, occurred_on: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="f-desc">Notes (optional)</label>
            <input id="f-desc" value={record.description} onChange={(e) => setRecord({ ...record, description: e.target.value })} />
          </div>
          <button className="btn btn--primary" onClick={logDelivery} disabled={!record.pledge_id || !record.quantity}>
            Log this
          </button>
        </section>
      )}
    </main>
  );
}
