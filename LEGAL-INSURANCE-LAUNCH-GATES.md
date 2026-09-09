# Legal and insurance launch gates

**Nothing in this repository is legally reviewed, insured, or approved.** No
statement anywhere in the product claims that the service is compliant, insured,
HIPAA compliant, or attorney approved. Every policy document ships as
`draft_requires_review` and renders a visible DRAFT banner.

## How the gate works

Seventeen `LaunchGate` rows across twelve categories are seeded at
`not_started`. Each declares the flags it blocks. `evaluateFlagChange()` refuses
to enable a flag whose required gate categories are not all `complete` and
unexpired, and `canFulfillRides()` re-checks on every operational ride
transition — so a gate that expires mid-pilot stops rides already in flight from
progressing, not just new ones.

Marking a gate complete requires an evidence link and a named reviewer, and the
reviewer may not be the person marking it. Every change is written to the
append-only `AuditLog`.

## Which gates block which flag

| Flag | Required categories |
|---|---|
| `ride_fulfillment_enabled` | regulatory, insurance, driver_auto_policy, legal_documents, background_checks, mvr_monitoring, privacy_security, support_coverage, partner_mou |
| `minor_rides_enabled` | the above minus partner_mou, plus child_safeguarding and child_restraint |
| `live_location_enabled` | privacy_security, legal_documents |
| `platform_donations_enabled` | payments_tax, legal_documents, privacy_security |
| `direct_driver_tips_enabled` | payments_tax, legal_documents, insurance, regulatory |
| `organization_in_kind_contributions_enabled` | legal_documents |

## Emergency override

An override is possible only for categories not on the non-overridable list, and
only with a typed justification of at least forty characters plus
re-authentication. It raises an audit alert.

**Never overridable, under any circumstance:** background_checks,
child_safeguarding, child_restraint, insurance. Nor can an override lower the
minimum driver age below 21, lower the minor-transport age below 25 or below its
current value, or bypass a missing consent or an expired credential.

## The seventeen gates

**Regulatory** — Michigan LARA determination or registration covering taxicab,
limousine, TNC, broker, or other transportation status for a free volunteer
program; City of Detroit authorization review.

**Insurance** — commercial and non-owned auto; general liability plus umbrella or
excess; volunteer accident; abuse and molestation (required for minors); cyber
and privacy plus directors and officers.

**Driver auto policy** — written confirmation of the minimum personal auto limits
drivers must carry, and the exclusions that apply to volunteer community
transportation.

**Legal documents** — every one of the fifteen `LegalDocument` rows at
`attorney_approved`.

**Background checks** — signed vendor agreement and a documented FCRA-compliant
adverse-action and dispute process.

**MVR monitoring** — pull cadence, driving-record eligibility policy, and
recurring re-check process.

**Child safeguarding** — safeguarding policy, mandated-reporter training, tested
incident-response runbook.

**Child restraint** — Michigan-compliant restraint inventory, fitting guidance,
inspection cadence.

**Payments and tax** — worker classification, TNC status, tax reporting, and tip
policy reviewed by counsel.

**Privacy and security** — completed privacy review, published retention
schedule, tested breach response, signed vendor agreements.

**Support coverage** — staffed phone coverage across service hours, an accessible
support channel, a rehearsed outage fallback.

**Partner MOU** — signed memorandum with the pilot resource partner covering
exact location, hours, participant communication, and escalation contacts.

## Open dependencies blocking the pilot

| Dependency | Effect while unresolved |
|---|---|
| No attorney or insurer review | Every policy renders the DRAFT banner. `legal_content_approved` stays false. |
| No legal operator named | The product shows "Pilot Operator — To Be Confirmed" everywhere. |
| No background-check vendor | Mode stays `mock_pending_review`, which never returns a pass, so no driver can be approved. |
| No geocoder credentials | Mock mode. Every request is flagged for manual dispatcher confirmation. |
| No authoritative Detroit boundary | The placeholder ring can only reject, never approve. Combined with mock geocoding, no address is ever auto-confirmed. |
| No notification provider | Notifications queue but do not send. |
| No payment credentials | Donations and tips stay off regardless of any flag. |
| No partner MOU | The pilot listing stays in draft. Its address, hours, contact, instructions, and description are blank by design. |

## What waivers do not do

The documents describe how the program works and what it does and does not
cover. None of them claims that all liability is waived, and none is relied on as
the only safety control. The controls are screening, credential currency
enforcement, verified accommodations, identity verification at pickup, deterministic
matching, human approval, incident response, and audit.
