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

**Credentials.** The expiring-within-30-days list is on the same board. The
overnight sweep marks lapsed documents expired, recomputes eligibility,
withdraws that driver's open offers, and queues them a notice thirty days ahead.
None of that needs you. What needs you is a phone call before the date, not
after.

Verifying a document is a two-person job by design: you cannot verify your own,
and you cannot verify a file that has not been scanned clean. While no scanner
is configured, that means credential verification is blocked — which is correct,
and is one of the launch-gate items.

**Escalations.** Every five minutes the check-in timers look at live rides. An
amber notice means a ride is past a threshold; an urgent alert reaches safety
staff and opens an incident. Treat both as "phone the driver", not as a verdict.
The timers read timestamps, not the road. A deliberate move by the driver clears
the escalation; the timer never decides on its own that things look fine again.

## Organizations

**Approving a scheduler.** An org admin proposes; you approve. Do not skip that
step because someone is in a hurry — a scheduler can request rides for other
people, so it is a privileged role with an audit trail.

**Authorization.** A scheduler cannot book for anyone until that person has
confirmed it in their own account. If a scheduler tells you the person "already
agreed on the phone", the answer is still no: ask them to send the request and
let the person press the button. There is no override, deliberately. For anyone
under 18 the answer is no full stop until Milestone 4 and the safeguarding gates.

**Pledges.** If an organization words a pledge as something in exchange for
rides, the server rejects it and asks them to reword. Take the chance to say the
thing out loud: rides are free, nobody works for one, and a pledge that falls
through has no consequence for any participant. Decline a pledge freely when you
cannot use it — the decline message already says access is unaffected.

## Reports

Show partners and organizations their own numbers, not each other's. The
software enforces that, but you should not try to work around it by pulling a
staff report and forwarding it.

Cells reading "too few to show" are withheld on purpose. Do not fill them in
from memory, do not publish them as zero, and do not narrow the date range until
a small cell becomes visible. If a partner needs a number that is suppressed, the
honest answer is that too few people sit behind it to share safely.

A CSV needs a written reason, and your name and that reason are recorded.

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

**Before service each day**, pull the manifest from the bottom of the Dispatch
board. Give the range and write why you need it — your name, the time, and your
reason are recorded, because this is the one export that puts home addresses,
phone numbers, and verification codes on one page. Print it, store it in the
locked cabinet at the dispatch desk, and shred it at end of day.

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
