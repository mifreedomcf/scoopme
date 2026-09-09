# Pilot runbook

## Before anything runs

1. Sign in as a Base44 admin, call `seed-pilot-data`.
2. Admin settings → set the legal operator name, the support phone, and the
   safety phone. Until the safety phone is set, active rides show a note that it
   is missing rather than a number.
3. Sit down with the resource partner and fill in the location's street address,
   opening hours, pickup instructions, inventory notes, accessibility notes, and
   the public description. **Nothing was guessed and nothing is published until
   you enter it.** Publish the partner and the location only after the MOU is
   signed.
4. Send all fifteen draft legal documents to counsel and the insurer. Publish an
   approved version before anyone relies on the text.
5. Work the launch checklist. `ride_fulfillment_enabled` cannot be turned on
   until the required gates are complete and unexpired.

## Daily dispatch

**Morning.** Open Dispatch. Work the review queue oldest first. A request with
`manual_review` geography carries a red note — confirm both addresses against the
service area by hand before approving, because the geocoder cannot confirm them.

**Approving.** Approve publishes minimized offers to every eligible driver. The
count comes back in the confirmation. Zero offers means no driver currently
passes the filters; waitlist it and say so to the rider.

**During rides.** Watch "In progress". A ride sitting in `en_route` past its
window, or in `arrived_pickup` without moving, is worth a phone call.

**Credentials.** The expiring-within-30-days list is on the same board. A driver
whose document expires becomes ineligible on the expiry date automatically —
their offers vanish and a claim in flight is refused. Call them before that, not
after.

## Incidents

1. Safety of the people involved first. 911 for any emergency. The app never
   delays a 911 call and does not replace it.
2. Move the ride to `incident_hold`. That sets a retention hold, so the record
   cannot be deleted or administratively closed while the hold is open.
3. File the SafetyIncident with type, severity, time, and narrative. The
   narrative is visible to safety staff and platform admins only, and stays out
   of every report and export.
4. Suspected abuse or neglect: report to the appropriate Michigan authority as a
   mandated reporter, then record it here. Do not investigate.
5. A failed handoff is not a routing problem. The driver stops, calls the safety
   line, stays with the rider, and does not choose a new destination.

## Outage fallback

The platform is not the only copy of the day's plan.

**Before service each day**, print or export the manifest: for every confirmed
ride, the rider name and phone, the pickup address, the destination, the window,
the driver name and phone, the vehicle description and plate, and the
verification code. Store it in the locked cabinet at the dispatch desk. It is a
sensitive document — shred it at end of day.

**If the app is down:**

1. Dispatch phones each driver and each rider from the manifest to confirm.
2. Identity verification still uses the printed verification code. Codes on paper
   are as valid as codes on a screen.
3. Log each completion on the manifest with the time and who reported it.
4. Emergencies still go to 911, then to the safety line. The phone tree is
   independent of the app.
5. When the app returns, a dispatcher reconciles each ride using
   `transition-ride` with the `outage_manual_entry` reason code, so the timeline
   shows what actually happened and when it was recorded.

## Things to say plainly, and things not to say

Say: rides are free, always; cancelling costs nothing and never affects future
rides; we cannot promise a driver will be available; call 911 in an emergency.

Do not say: that the service is insured, compliant, HIPAA compliant, or attorney
approved; that a donation is tax deductible; that any tip amount is tax free; or
that a partner or an individual is the operator, carrier, insurer, or guarantor.

## Escalation

| Situation | Who |
|---|---|
| Ride cannot be filled | Dispatcher |
| Credential expiring or disputed | Safety staff |
| Failed handoff, missing rider, crash, injury | Safety staff immediately, then platform admin |
| Suspected abuse or neglect | Mandated report to the state authority, then safety staff |
| Data breach or suspected breach | Platform admin, then the breach-response plan |
| Partner site closed or unsafe | Dispatcher, then the partner escalation contact in admin settings |
