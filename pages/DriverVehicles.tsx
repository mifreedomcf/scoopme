import { useEffect, useState } from "react";
import { base44, manageVehicle, type ApiError } from "@/lib/api";
import { Empty } from "@/components/Chrome";

interface Vehicle {
  id: string;
  make?: string; model?: string; year?: number; color?: string;
  seating_capacity?: number; status: string;
  inspection_required?: boolean; inspection_status?: string; inspection_expiration?: string;
}

interface Capability {
  id: string; vehicle_id: string; capability: string;
  quantity: number; verification_status: string;
}

const CAPABILITIES: [string, string][] = [
  ["wheelchair_lift", "Wheelchair lift"],
  ["wheelchair_ramp", "Wheelchair ramp"],
  ["wheelchair_securement", "Wheelchair securement straps"],
  ["booster_seat", "Booster seat"],
  ["forward_facing_car_seat", "Forward-facing car seat"],
  ["rear_facing_car_seat", "Rear-facing car seat"],
  ["service_animal_ok", "Service animals welcome"],
  ["extra_passenger_space", "Extra space for bags or equipment"],
  ["step_stool", "Step stool"],
  ["oxygen_tank_space", "Space for an oxygen tank"],
];

export default function DriverVehicles() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    make: "", model: "", year: "", color: "", license_plate: "", plate_state: "MI",
    seating_capacity: "4", capabilities: [] as string[],
  });

  const load = async () => {
    setVehicles((await base44.entities.Vehicle.list("-created_date", 10)) as Vehicle[]);
    setCapabilities((await base44.entities.VehicleCapability.list("capability", 50)) as Capability[]);
  };

  useEffect(() => { load().catch(() => setNote("We could not load your vehicles.")); }, []);

  async function save() {
    setNote(null);
    try {
      const result = await manageVehicle({
        make: form.make,
        model: form.model,
        year: Number(form.year),
        color: form.color,
        license_plate: form.license_plate,
        plate_state: form.plate_state,
        seating_capacity: Number(form.seating_capacity),
        capabilities: form.capabilities.map((capability) => ({ capability, quantity: 1 })),
      });
      const r = result as { message: string; note: string };
      setNote(`${r.message} ${r.note}`);
      setAdding(false);
      await load();
    } catch (err) {
      const e = err as ApiError;
      setNote(e.fields?.map((f) => f.message).join(" ") ?? e.message);
    }
  }

  const toggle = (key: string) =>
    setForm({
      ...form,
      capabilities: form.capabilities.includes(key)
        ? form.capabilities.filter((c) => c !== key)
        : [...form.capabilities, key],
    });

  return (
    <main id="main" className="pad">
      <h1>Your car</h1>
      {note && <p role="status" className="field-error">{note}</p>}

      {vehicles.length === 0 && !adding && (
        <Empty
          title="No car on file"
          body="Add the car you will be driving so riders can recognise it at pickup."
          action={<button className="btn btn--primary" onClick={() => setAdding(true)}>Add a car</button>}
        />
      )}

      {vehicles.map((v) => {
        const caps = capabilities.filter((c) => c.vehicle_id === v.id);
        return (
          <article className="record" key={v.id}>
            <span className={`status status--${v.status === "active" ? "go" : "wait"}`}>
              {v.status.replace(/_/g, " ")}
            </span>
            <h3>{v.color} {v.year} {v.make} {v.model}</h3>
            <p className="meta">Seats {v.seating_capacity}</p>
            {v.inspection_required && (
              <p className="field-error">
                This car needs a current licensed-mechanic inspection on file before it can be used.
                {v.inspection_expiration && ` Current one expires ${v.inspection_expiration}.`}
              </p>
            )}
            <h4>What it can do</h4>
            {caps.length === 0 && <p className="meta">Nothing listed yet.</p>}
            <ul>
              {caps.map((c) => (
                <li key={c.id}>
                  {CAPABILITIES.find(([k]) => k === c.capability)?.[1] ?? c.capability}
                  {" — "}
                  <strong>
                    {c.verification_status === "verified" ? "checked by a coordinator" : "not checked yet"}
                  </strong>
                </li>
              ))}
            </ul>
            <p className="meta">
              A rider who needs one of these is only matched with you once a coordinator has seen it in
              person. Listing it here is not enough on its own.
            </p>
          </article>
        );
      })}

      {adding && (
        <section aria-labelledby="add-car">
          <h2 id="add-car">Add your car</h2>
          {([
            ["make", "Make", "text"], ["model", "Model", "text"], ["year", "Year", "number"],
            ["color", "Colour", "text"], ["license_plate", "Plate", "text"],
            ["seating_capacity", "Seats, including you", "number"],
          ] as [keyof typeof form, string, string][]).map(([key, label, type]) => (
            <div className="field" key={key}>
              <label htmlFor={`v-${key}`}>{label}</label>
              <input
                id={`v-${key}`}
                type={type}
                value={String(form[key])}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            </div>
          ))}

          <fieldset className="field" style={{ border: 0, padding: 0 }}>
            <legend style={{ fontWeight: 700 }}>What can your car do?</legend>
            <span className="hint">A coordinator checks each of these before a rider who needs it is matched with you.</span>
            {CAPABILITIES.map(([key, label]) => (
              <div className="check" key={key}>
                <input id={`cap-${key}`} type="checkbox" checked={form.capabilities.includes(key)} onChange={() => toggle(key)} />
                <label htmlFor={`cap-${key}`}>{label}</label>
              </div>
            ))}
          </fieldset>

          <div className="actions">
            <button className="btn btn--primary" onClick={save}>Save my car</button>
            <button className="btn btn--secondary" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </section>
      )}

      {vehicles.length > 0 && !adding && (
        <div className="actions">
          <button className="btn btn--secondary" onClick={() => setAdding(true)}>Add another car</button>
        </div>
      )}
    </main>
  );
}
