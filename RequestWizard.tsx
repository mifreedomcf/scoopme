import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, base44, submitRideRequest, type AppConfig, type ApiFieldError } from "@/lib/api";
import { ErrorSummary, FreeStatement } from "@/components/Chrome";
import { RESOURCE_CATEGORY_LABELS } from "@/lib/ride-display";

interface Destination {
  id: string;
  name: string;
  zip_code?: string;
  resource_categories?: string[];
  operating_hours_text?: string;
  pickup_instructions?: string;
}

const NEEDS = [
  { key: "wheelchair_lift", label: "Wheelchair lift" },
  { key: "wheelchair_securement", label: "Wheelchair securement" },
  { key: "door_to_door_assist", label: "Help from my door to the car" },
  { key: "service_animal", label: "I travel with a service animal" },
  { key: "extra_space", label: "Extra space for bags or equipment" },
];

const STEPS = ["Where you are going", "When you need to be there", "Getting around", "Check and send"];

export default function RequestWizard({ config }: { config: AppConfig | null }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [errors, setErrors] = useState<ApiFieldError[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);

  const [form, setForm] = useState({
    destination_location_id: "",
    resource_category: "free_fridge",
    pickup_address: "",
    requested_pickup_at: "",
    arrival_by_at: "",
    flexible_window_minutes: 30,
    passenger_count: 1,
    contact_phone: "",
    language_preference: "en",
    assistance_level: "curb_to_curb",
    service_animal: false,
    operational_notes: "",
    needs: [] as string[],
  });

  useEffect(() => {
    base44.entities.ResourceLocation.filter({ status: "published", is_pilot_destination: true }, "name", 50)
      .then((rows) => setDestinations(rows as Destination[]))
      .catch(() => setDestinations([]));
  }, []);

  useEffect(() => {
    if (errors.length > 0) summaryRef.current?.focus();
  }, [errors]);

  const chosen = useMemo(
    () => destinations.find((d) => d.id === form.destination_location_id) ?? null,
    [destinations, form.destination_location_id],
  );

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const toggleNeed = (key: string) =>
    set({ needs: form.needs.includes(key) ? form.needs.filter((n) => n !== key) : [...form.needs, key] });

  async function send() {
    setSaving(true);
    setErrors([]);
    setBanner(null);
    try {
      const result = await submitRideRequest({
        destination_location_id: form.destination_location_id || undefined,
        resource_category: form.resource_category,
        pickup_address: form.pickup_address,
        requested_pickup_at: form.requested_pickup_at ? new Date(form.requested_pickup_at).toISOString() : "",
        arrival_by_at: form.arrival_by_at ? new Date(form.arrival_by_at).toISOString() : undefined,
        flexible_window_minutes: Number(form.flexible_window_minutes),
        passenger_count: Number(form.passenger_count),
        contact_phone: form.contact_phone,
        language_preference: form.language_preference,
        assistance_level: form.assistance_level,
        service_animal: form.needs.includes("service_animal"),
        operational_notes: form.operational_notes,
        requested_by_kind: "self",
        needs: form.needs.map((need) => ({ need, quantity: 1 })),
      });
      navigate(`/rides/${(result as { ride_request_id: string }).ride_request_id}`);
    } catch (err) {
      const e = err as ApiError;
      setErrors(e.fields ?? []);
      setBanner(e.message);
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((e) => e.field === field);

  return (
    <main id="main" className="pad">
      <h1>Ask for a ride</h1>
      <p className="meta">
        Step {step + 1} of {STEPS.length}: {STEPS[step]}
      </p>
      <FreeStatement />

      <div ref={summaryRef}>
        <ErrorSummary errors={errors.map((e) => ({ field: e.field, message: e.message }))} />
      </div>
      {banner && errors.length === 0 && <p className="field-error" role="alert">{banner}</p>}

      {step === 0 && (
        <section aria-label="Where you are going">
          <div className="field">
            <label htmlFor="field-destination_location_id">Where are you going?</label>
            <span className="hint">
              During the pilot we drive to approved locations in{" "}
              {config?.pilot.allowed_destination_zip_codes.join(", ") ?? "the pilot area"}.
            </span>
            <select
              id="field-destination_location_id"
              value={form.destination_location_id}
              onChange={(e) => set({ destination_location_id: e.target.value })}
            >
              <option value="">Choose a place</option>
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            {destinations.length === 0 && (
              <p className="hint">
                No destinations are published yet. A coordinator adds the address and opening hours before the
                pilot opens.
              </p>
            )}
            {errorFor("destination_location_id") && (
              <p className="field-error">{errorFor("destination_location_id")?.message}</p>
            )}
          </div>

          {chosen?.operating_hours_text && (
            <p className="meta">Open: {chosen.operating_hours_text}</p>
          )}

          <div className="field">
            <label htmlFor="field-resource_category">What are you going for?</label>
            <span className="hint">
              We record the kind of place only. We never ask what is wrong with you or why you need it.
            </span>
            <select
              id="field-resource_category"
              value={form.resource_category}
              onChange={(e) => set({ resource_category: e.target.value })}
            >
              {Object.entries(RESOURCE_CATEGORY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="field-pickup_address">Where should the driver pick you up?</label>
            <span className="hint">Street address inside {config?.pilot.service_area_label ?? "Detroit"}.</span>
            <input
              id="field-pickup_address"
              autoComplete="street-address"
              value={form.pickup_address}
              onChange={(e) => set({ pickup_address: e.target.value })}
            />
            {errorFor("pickup_address") && <p className="field-error">{errorFor("pickup_address")?.message}</p>}
          </div>
        </section>
      )}

      {step === 1 && (
        <section aria-label="When you need to be there">
          <div className="field">
            <label htmlFor="field-requested_pickup_at">Pickup time</label>
            <span className="hint">
              At least {config?.pilot.minimum_request_lead_hours ?? 24} hours from now.
            </span>
            <input
              id="field-requested_pickup_at"
              type="datetime-local"
              value={form.requested_pickup_at}
              onChange={(e) => set({ requested_pickup_at: e.target.value })}
            />
            {errorFor("requested_pickup_at") && (
              <p className="field-error">{errorFor("requested_pickup_at")?.message}</p>
            )}
          </div>

          <div className="field">
            <label htmlFor="field-arrival_by_at">Be there by (optional)</label>
            <input
              id="field-arrival_by_at"
              type="datetime-local"
              value={form.arrival_by_at}
              onChange={(e) => set({ arrival_by_at: e.target.value })}
            />
            {errorFor("arrival_by_at") && <p className="field-error">{errorFor("arrival_by_at")?.message}</p>}
          </div>

          <div className="field">
            <label htmlFor="field-flexible_window_minutes">How flexible is that time?</label>
            <select
              id="field-flexible_window_minutes"
              value={form.flexible_window_minutes}
              onChange={(e) => set({ flexible_window_minutes: Number(e.target.value) })}
            >
              <option value={15}>Within 15 minutes</option>
              <option value={30}>Within 30 minutes</option>
              <option value={60}>Within an hour</option>
              <option value={120}>Within two hours</option>
            </select>
          </div>
        </section>
      )}

      {step === 2 && (
        <section aria-label="Getting around">
          <fieldset className="field" style={{ border: 0, padding: 0, margin: "0 0 1.25rem" }}>
            <legend style={{ fontWeight: 700 }}>What do you need on the day?</legend>
            <span className="hint">
              We only match you with a driver whose ability to do these has been checked.
            </span>
            {NEEDS.map((n) => (
              <div className="check" key={n.key}>
                <input
                  id={`need-${n.key}`}
                  type="checkbox"
                  checked={form.needs.includes(n.key)}
                  onChange={() => toggleNeed(n.key)}
                />
                <label htmlFor={`need-${n.key}`}>{n.label}</label>
              </div>
            ))}
          </fieldset>

          <div className="field">
            <label htmlFor="field-passenger_count">How many people are riding?</label>
            <input
              id="field-passenger_count"
              type="number"
              min={1}
              max={8}
              value={form.passenger_count}
              onChange={(e) => set({ passenger_count: Number(e.target.value) })}
            />
            {errorFor("passenger_count") && <p className="field-error">{errorFor("passenger_count")?.message}</p>}
          </div>

          <div className="field">
            <label htmlFor="field-contact_phone">Phone number for the day</label>
            <span className="hint">Only the coordinator and your matched driver can see this.</span>
            <input
              id="field-contact_phone"
              type="tel"
              autoComplete="tel"
              value={form.contact_phone}
              onChange={(e) => set({ contact_phone: e.target.value })}
            />
            {errorFor("contact_phone") && <p className="field-error">{errorFor("contact_phone")?.message}</p>}
          </div>

          <div className="field">
            <label htmlFor="field-operational_notes">Anything the driver should know? (optional)</label>
            <span className="hint">
              Practical things only, like &quot;buzzer is broken, call when you arrive&quot;.
            </span>
            <textarea
              id="field-operational_notes"
              value={form.operational_notes}
              onChange={(e) => set({ operational_notes: e.target.value })}
            />
          </div>
        </section>
      )}

      {step === 3 && (
        <section aria-label="Check and send">
          <h2>Check this over</h2>
          <dl>
            <dt><strong>Going to</strong></dt>
            <dd>{chosen?.name ?? "Not chosen yet"}</dd>
            <dt><strong>Picked up at</strong></dt>
            <dd>{form.pickup_address || "Not entered yet"}</dd>
            <dt><strong>Pickup time</strong></dt>
            <dd>{form.requested_pickup_at || "Not chosen yet"}</dd>
            <dt><strong>Riding</strong></dt>
            <dd>{form.passenger_count} {form.passenger_count === 1 ? "person" : "people"}</dd>
            <dt><strong>You need</strong></dt>
            <dd>{form.needs.length ? form.needs.join(", ") : "Nothing extra"}</dd>
            <dt><strong>Cost</strong></dt>
            <dd>Nothing.</dd>
          </dl>
          {!config?.fulfillment_status.allowed && (
            <p className="field-error">
              Rides are not being driven yet. Your request is saved and reviewed, but no driver will be sent
              until the pilot finishes its safety and insurance checks.
            </p>
          )}
        </section>
      )}

      <div className="actions">
        {step > 0 && (
          <button className="btn btn--secondary" onClick={() => setStep((s) => s - 1)}>Back</button>
        )}
        {step < STEPS.length - 1 ? (
          <button className="btn btn--primary" onClick={() => setStep((s) => s + 1)}>Continue</button>
        ) : (
          <button className="btn btn--primary" onClick={send} disabled={saving}>
            {saving ? "Sending…" : "Send my request"}
          </button>
        )}
      </div>
    </main>
  );
}
