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
ride ends, is never in a notification, and is never shown to the driver.
Residual: social engineering of the code. Milestone 2 adds the driver-side
confirmation step and check-in timers.

## T3 — Credential fraud or a lapsed driver keeps driving

Mitigated: a driver can never self-approve — `driver-application-review` requires
a different reviewer and refuses approval while any required credential is
unverified or expired. Eligibility is recomputed from live credential rows at
offer time *and* again at claim time, so a credential that expires between the
two blocks the claim. `list-driver-offers` returns nothing to a driver who is not
`eligible`.
Residual: a credential verified in error. Milestone 2 adds expiry automation,
advance notices, and recurring MVR monitoring.

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

## T14 — Evidence destroyed after an incident

Mitigated: opening an incident sets a retention hold, `closed_by_admin` is
refused while a hold is active, `hasActiveHold()` fails closed, and RideEvent and
AuditLog cannot be deleted by anyone.
