# Threat model

Scope: Milestone 1. Assets are riders' whereabouts and identity, drivers'
identity and credential records, the integrity of the eligibility decision, and
the audit trail.

## T1 — Someone locates a rider through the platform

*A person creates a driver account, or an approved driver browses, to find where
a specific person lives or when they leave the house.*

Mitigated: offers carry an approximate area label, a category, a window, and a
count. `minimizeRide()` decides the payload centrally, and the driver-facing
functions call it. Exact addresses reach only the assigned driver, only inside a
two-hour reveal window, only in an active state, and the reveal is audited. There
is no driver-facing browse of riders and no directory of drivers.
Residual: an assigned driver necessarily learns one address once. The audit trail
and the incident workflow are the control, not prevention.

## T2 — An unauthorized person collects a rider

*Someone arrives claiming to be the driver.*

Mitigated: the rider sees the driver's name, photo, vehicle make, model, colour,
and plate before pickup, and a rotating six-character verification code from an
unambiguous alphabet. The code rotates on every confirmation, is cleared when the
ride ends, is never in a notification, and is never sent to the driver's device
in any projection. The driver types what the rider says aloud;
`verify-ride-identity` compares it server-side, caps guessing at five attempts
per fifteen minutes, and audits every attempt. A ride cannot reach `in_progress`
without passing through `rider_verified`.
Residual: social engineering of the code out of the rider. The driver-facing copy
tells drivers not to guess and to call the safety line instead.

## T3 — Credential fraud or a lapsed driver keeps driving

Mitigated: a driver can never self-approve — `driver-application-review` requires
a different reviewer and refuses approval while any required credential is
unverified or expired. Eligibility is recomputed from live credential rows at
offer time *and* again at claim time, so a credential that expires between the
two blocks the claim. `list-driver-offers` returns nothing to a driver who is not
`eligible`.
`credential-expiry-sweep` runs daily: it marks lapsed documents `expired`,
recomputes every driver's eligibility, withdraws the open offers of anyone who
just dropped out, and queues advance notices thirty days ahead, deduplicated per
credential per expiry date. `computeEligibility()` never clears an
administrative suspension or an incident hold by recomputation.
Residual: a credential verified in error, and recurring MVR monitoring, which
depends on the vendor gate.

## T4 — Two drivers claim one ride

Mitigated: `claim-ride` creates the assignment, re-reads all active assignments,
keeps the earliest by creation time then id, and deactivates the loser with
`lost_claim_race`. `assign-ride` refuses when an active assignment exists.
Residual: Base44 has no multi-document transaction, so this is a compensating
lock rather than a true one. Milestone 7 load-tests the race and adds a
uniqueness constraint if the platform grows one.

## T5 — Identifier tampering

Mitigated: every read and write resolves the caller's relationship to the record
server-side. Unrelated callers get `404`. Entity RLS scopes direct client reads
to `created_by` or admin. The denied attempt is audited.

## T6 — A malicious or careless organization

*A CBO schedules rides for people who never asked, or acts as a guardian.*

Mitigated: an organization request requires a current
`OrganizationParticipantAuthorization` for that exact participant, checked
server-side against the organization the caller is actually approved for.
Validation rejects a scheduler as a consenting party for a minor outright.
Reports are scoped to the organization's own participants with small-cell
suppression.

## T6b — An organization books rides for people who did not ask

*A CBO adds its whole caseload as "participants" and starts booking, or keeps
booking after someone has left the programme.*

Mitigated: the organization can only create a `pending` request, and only the
participant can activate it from their own account —
`request-participant-authorization` has no code path that writes an active
status and never touches the record after creating it. Authorizations expire
after a year, and a withdrawal is immediate. An org admin can propose a
scheduler but cannot approve one; a platform admin does that, and the grant is
mirrored onto `RoleAssignment`, which is what authorization actually reads.
Residual: a participant can be pressured into confirming. The wording on the
confirmation screen says plainly that saying no does not affect their own rides.

## T6c — A report becomes a way to identify someone

*A partner report shows one wheelchair ride from one ZIP, and everyone at the
site knows who that was.*

Mitigated: any cell drawn from fewer than five distinct people is written as
`suppressed`, including inside a breakdown of an otherwise large report, and
including in CSV. A suppressed cell is never rendered as zero, so nobody
republishes it as one. Scope is applied before aggregation and derived from the
caller's role, so an organization cannot request a partner's view or another
organization's. Minors are excluded from every non-staff audience.
Residual: repeated queries across shifting date ranges could narrow a cell.
Milestone 7 adds query logging review; every export is already audited.

## T7 — Insider misuse by staff

Mitigated: least privilege across eight roles, each approved and recorded. Staff
views of a ride are audited. Config and gate changes are audited with the field
list. Overrides require typed justification plus re-authentication and raise an
audit alert. Gate completion requires a reviewer who is not the person marking
it. AuditLog and RideEvent cannot be edited or deleted by anyone.
Residual: a platform admin remains highly privileged. Milestone 7 adds step-up
authentication and admin session revocation.

## T8 — Off-platform contact between a driver and a rider

Partially mitigated: contact details are released late and narrowly, and the
driver agreement prohibits off-platform contact. For minors, direct contact is
architecturally prevented — communication routes through the guardian and the
platform with masked contacts and logged access.
Residual: an assigned driver has a phone number for one trip. Detection is via
incident reports, not prevention.

## T9 — Location leakage through notifications

Mitigated: templates use generic labels only, `assertNotificationSafe()` checks
each rendered body against the real record, and sensitive-context templates are
barred from SMS.

## T10 — Payment abuse

Mitigated by absence. There is no fare, no payment method on the ride path, and
no card data anywhere. Donations and tips are off, gated behind `payments_tax`
and `legal_documents`, and the tip cap is pinned to zero while tipping is
disabled. `ACCEPTED_REQUEST_FIELDS` contains nothing matching payment, fare, tip,
donation, pledge, or contribution, and a test asserts that.

## T11 — Compromised account

Partially mitigated: suspension strips every role immediately via `Principal`,
and a suspended account fails `requireRole` before any check runs.
Residual: no MFA, no session revocation, no device list. Milestone 7.

## T12 — Prompt injection or model-driven decisions

Mitigated by design. No model participates in matching, eligibility, identity
verification, background-check decisions, emergency decisions, or consent. Every
one of those is a deterministic rule in `base44/shared/` with an explainable
verdict, and human approval is required for ride approval and driver approval.

## T13 — A dangerous configuration is enabled by accident

Mitigated: `evaluateFlagChange()` refuses to enable a flag whose launch gates are
incomplete or expired; refuses any override touching background checks,
safeguarding, child restraints, or insurance; refuses a driver age below 21 or a
minor-transport age below 25 or below its current value. `canFulfillRides()` is
re-evaluated on every operational transition, so an expiring gate stops rides
already in flight from progressing rather than only blocking new ones.

## T15 — A malicious file reaches a reviewer

*Someone uploads a disguised executable as a "licence", or a poisoned file as
incident evidence.*

Mitigated: `validateUpload()` enforces a per-purpose content-type and extension
allowlist, a size ceiling, a safe-filename pattern, a single-extension rule, and
agreement between the declared type and the extension. Every reference must be a
private storage reference; a URL is rejected. Files stay `pending` until a
scanner returns clean, `mayServeAttachment()` gates serving on exactly `clean`,
and a credential with an unscanned document cannot be verified.
Residual: no live scanner is configured, so in practice no uploaded file is
served at all. That is safe but incomplete; the live scanner is Milestone 7.

## T16 — A ride goes quiet and nobody notices

Mitigated: `ride-checkin-sweep` watches every live ride against departure,
arrival, stall, silence, and handoff thresholds, escalating from a dispatcher
notice to an urgent alert reaching safety staff at twice the threshold, and
opening an incident at urgent level so a named person owns it. Each level fires
once; a deliberate move by a person resets the timer and clears the escalation.
Residual: the timers infer from timestamps, not from the road. They are a prompt
for a phone call, not a safety guarantee, and the runbook says so.

## T17 — A notification leaks ride detail after a template change

Mitigated: `assertNotificationSafe()` runs at render time in the test suite and
again against the live ride record immediately before dispatch. A body carrying
an address, phone number, or code is marked `failed` and audited rather than
sent. Sensitive-context templates are barred from SMS.

## T18 — Contributions become a price for access

*An organization implies its participants get better service because it donates
hours, or an operator starts treating pledges as a queue.*

Mitigated structurally rather than by policy. No contribution field exists on the
ride path: `ACCEPTED_REQUEST_FIELDS` contains nothing matching pledge, donation,
credit, or balance, and the matcher's inputs contain no such key either — both
asserted by test. The contribution entities have no balance, debt, credit,
priority, or tier field at all, and `summariseFulfillment` floors outstanding at
zero, so there is nothing to owe. A pledge whose wording ties it to anyone's ride
is rejected server-side with a message explaining that rides are free and
unconditional. Every contribution response states `rider_access_effect: "none"`
in so many words, and `contributionAffectsRideAccess()` exists purely so a test
can point at the guarantee.
Residual: an operator could still favour a donor informally. The audit trail of
every dispatcher decision is the control, plus the fact that the matcher is
deterministic and its reasons are recorded on each offer.

## T19 — A child is handed to the wrong person

*Someone arrives at the drop-off claiming to be there for the child.*

Mitigated: the driver picks from a list of adults the guardian recorded by name,
relationship, and role, and that adult reads out a rotating PIN the driver has
never seen. `verifyHandoff` refuses an unlisted adult, a removed one, one listed
for another child, one listed for the other leg, one not expected for this trip,
a reused PIN, a stale PIN, and a wrong PIN — three attempts, then stop. No
failure message hints at the expected value, and no failure path offers an
alternative destination or any option that involves leaving the child. A real
failure freezes the ride, opens a safeguarding incident with a retention hold,
and alerts both dispatch and safety staff.
Residual: an adult on the list could still be the wrong person to release a
child to on a given day. The guardian can deactivate them, and a failed handoff
is always a phone call, never a judgement the driver makes alone.

## T20 — Someone stands in for a guardian

*A case manager, teacher, or CBO scheduler signs "on the family's behalf".*

Mitigated: `canSignForMinor` refuses every relationship except verified legal
authority — scheduler, referring adult, dispatcher, and self-signature all get an
explicit no with a message naming what is actually required. Authority itself is
verified by staff against a private document that has been scanned clean, carries
a mandatory re-verification date, and cannot be self-verified. Participant
authorization is closed to under-18s entirely, so the Milestone 3 route cannot be
used as a back door.
Residual: a determined forger could produce a convincing document. The control is
human review plus the audit record of who verified what and when.

## T21 — A child travels without the right restraint

Mitigated: `requiredRestraint` picks the restraint from age, with the more
protective answer whenever information is missing, and
`vehicleSatisfiesRestraint` accepts only a verified, unexpired capability in the
assigned vehicle — a driver's own word is not availability. A car with no rear
seat fails for a child who needs one. The whole table is unreviewed by default
and blocks every minor ride until counsel signs it off.
Residual: the table is our reading of the statute, not counsel's. That is exactly
what the `child_restraint` launch gate is for, and nothing runs until it closes.

## T22 — A driver and a child talk privately

Mitigated structurally. No thread configuration permits it:
`threadMembershipAllowed` refuses the driver-plus-child pair, refuses a child's
thread with no guardian, and refuses a child as a participant at all. It is
re-checked on every post, not only at creation. Contact-sharing attempts on a
child's thread are refused and flagged rather than quietly stripped, and every
read is audited.

## T14 — Evidence destroyed after an incident

Mitigated: opening an incident sets a retention hold before anything else,
`closed_by_admin` is refused while a hold is active, `hasActiveHold()` fails
closed, and RideEvent and AuditLog cannot be deleted by anyone. Releasing a hold
requires the incident to be closed, a platform administrator, and a written
justification, and is audited as an override. A safeguarding incident cannot be
closed at all until the mandated report to the state authority is recorded.
