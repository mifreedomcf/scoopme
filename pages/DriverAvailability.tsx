import { useEffect, useState } from "react";
import { addAvailability, base44, cancelAvailability, type ApiError } from "@/lib/api";
import { Empty } from "@/components/Chrome";

interface Window { id: string; starts_at: string; ends_at: string; status: string; notes?: string }

function label(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function DriverAvailability() {
  const [windows, setWindows] = useState<Window[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [form, setForm] = useState({ starts_at: "", ends_at: "", notes: "" });

  const load = async () => {
    const rows = (await base44.entities.DriverAvailability.filter({ status: "active" }, "starts_at", 50)) as Window[];
    setWindows(rows);
  };

  useEffect(() => { load().catch(() => setNote("We could not load your times.")); }, []);

  async function add() {
    setNote(null);
    try {
      await addAvailability(
        new Date(form.starts_at).toISOString(),
        new Date(form.ends_at).toISOString(),
        form.notes || undefined,
      );
      setForm({ starts_at: "", ends_at: "", notes: "" });
      await load();
    } catch (err) {
      const e = err as ApiError;
      setNote(e.fields?.map((f) => f.message).join(" ") ?? e.message);
    }
  }

  async function remove(id: string) {
    setNote(null);
    try {
      await cancelAvailability(id);
      await load();
    } catch (err) {
      setNote((err as ApiError).message);
    }
  }

  return (
    <main id="main" className="pad">
      <h1>When you can drive</h1>
      <p>You are only offered rides that sit entirely inside one of these windows.</p>
      {note && <p role="status" className="field-error">{note}</p>}

      <section aria-labelledby="add-window">
        <h2 id="add-window">Add a window</h2>
        <div className="field">
          <label htmlFor="a-start">From</label>
          <input id="a-start" type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="a-end">Until</label>
          <span className="hint">Up to 14 hours at a stretch.</span>
          <input id="a-end" type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="a-notes">Notes for the coordinator (optional)</label>
          <input id="a-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </div>
        <button className="btn btn--primary" onClick={add}>Add this window</button>
      </section>

      <section aria-labelledby="your-windows">
        <h2 id="your-windows">Your windows</h2>
        {windows.length === 0 && (
          <Empty title="Nothing set" body="Add a window above and rides that fit inside it will show up on your Driving page." />
        )}
        {windows.map((w) => (
          <article className="record" key={w.id}>
            <h3>{label(w.starts_at)} → {label(w.ends_at)}</h3>
            {w.notes && <p className="meta">{w.notes}</p>}
            <button className="btn btn--secondary" onClick={() => remove(w.id)}>Remove this window</button>
          </article>
        ))}
        <p className="footnote">
          If you have already taken a ride inside a window, remove the ride first. That way a coordinator
          can find someone else instead of a rider being left waiting.
        </p>
      </section>
    </main>
  );
}
