import type { AppConfig } from "@/lib/api";

/** Donations and non-cash contributions. Both start in a clear disabled state. */
export default function Support({ config }: { config: AppConfig | null }) {
  const donations = Boolean(config?.flags.platform_donations_enabled);
  const inKind = Boolean(config?.flags.organization_in_kind_contributions_enabled);

  return (
    <main id="main" className="pad">
      <h1>Supporting the service</h1>

      <div className="free-rule">
        <strong>Giving changes nothing about who gets a ride.</strong>
        <span>
          Donating, volunteering, or bringing supplies never affects eligibility, priority, matching,
          service quality, or access. Nobody is ever asked to work or contribute in exchange for their own
          ride.
        </span>
      </div>

      <section aria-labelledby="donations">
        <h2 id="donations">Money</h2>
        {donations ? (
          <p>
            Donations go through a hosted payment page. No card details ever reach this app.
          </p>
        ) : (
          <p>
            Donations are switched off. They stay off until payment setup and legal review are finished. No
            statement about tax deductibility will be made until the legal recipient and required disclosures
            are configured and approved.
          </p>
        )}
        <button className="btn btn--primary" disabled={!donations}>
          {donations ? "Donate" : "Donations unavailable"}
        </button>
      </section>

      <section aria-labelledby="inkind">
        <h2 id="inkind">Hours and supplies</h2>
        {inKind ? (
          <p>
            An organization can pledge volunteer hours or requested supplies. A pledge is voluntary. An
            unfulfilled pledge never creates a debt, a penalty, or a restriction on anyone&apos;s rides.
          </p>
        ) : (
          <p>Organization pledges are switched off right now.</p>
        )}
      </section>

      <section aria-labelledby="tips">
        <h2 id="tips">Tipping drivers</h2>
        <p>
          Tipping is switched off. Drivers are volunteers and do not expect or ask for tips.
        </p>
        <p className="meta">
          If tipping is ever enabled after legal, tax, insurance, payment-processor, and worker-classification
          review, it will be optional, never preselected, never requested, and only available after a ride is
          finished. Tips may be taxable even if you do not receive a tax form. Consult a tax professional.
        </p>
      </section>
    </main>
  );
}
