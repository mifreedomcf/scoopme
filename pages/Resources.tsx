import { useEffect, useState } from "react";
import { base44 } from "@/lib/api";
import { Empty } from "@/components/Chrome";
import { RESOURCE_CATEGORY_LABELS } from "@/lib/ride-display";

interface Partner { id: string; name: string; public_description?: string; acknowledgement_text?: string; acknowledgement_approved?: boolean; website_url?: string }
interface Location {
  id: string; partner_id: string; name: string; street_address?: string; zip_code?: string;
  resource_categories?: string[]; operating_hours_text?: string; pickup_instructions?: string;
  inventory_notes?: string; accessibility_notes?: string;
}

export default function Resources() {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);

  useEffect(() => {
    base44.entities.ResourcePartner.filter({ status: "published" }, "name", 50)
      .then((rows) => setPartners(rows as Partner[])).catch(() => setPartners([]));
    base44.entities.ResourceLocation.filter({ status: "published" }, "name", 100)
      .then((rows) => setLocations(rows as Location[])).catch(() => setLocations([]));
  }, []);

  return (
    <main id="main" className="pad">
      <h1>Where we drive</h1>
      <p>Community places in the pilot area that you can ask for a ride to.</p>

      {partners.length === 0 && (
        <Empty
          title="Nothing published yet"
          body="A coordinator publishes each place once the partner has confirmed the address, opening hours, and what to expect when you get there. Nothing is listed until then."
        />
      )}

      {partners.map((p) => (
        <section key={p.id} aria-labelledby={`partner-${p.id}`}>
          <h2 id={`partner-${p.id}`}>{p.name}</h2>
          {p.public_description ? <p>{p.public_description}</p> : <p className="meta">Description to be confirmed with the partner.</p>}
          {p.acknowledgement_approved && p.acknowledgement_text && <p className="meta">{p.acknowledgement_text}</p>}
          {p.website_url && <p><a href={p.website_url}>Visit their website</a></p>}

          {locations.filter((l) => l.partner_id === p.id).map((l) => (
            <article className="record" key={l.id}>
              <h3>{l.name}</h3>
              <p className="meta">
                {(l.resource_categories ?? []).map((c) => RESOURCE_CATEGORY_LABELS[c] ?? c).join(" · ")}
              </p>
              <p>{l.street_address ? `${l.street_address}, Detroit, MI ${l.zip_code ?? ""}` : "Address to be confirmed."}</p>
              <p>{l.operating_hours_text || "Opening hours to be confirmed."}</p>
              {l.pickup_instructions && <p>{l.pickup_instructions}</p>}
              {l.inventory_notes && <p className="meta">{l.inventory_notes}</p>}
              {l.accessibility_notes && <p className="meta">Access: {l.accessibility_notes}</p>}
            </article>
          ))}
        </section>
      ))}
    </main>
  );
}
