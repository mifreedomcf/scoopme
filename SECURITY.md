# Security

## Authorization model

Base44 gives every user a platform role of `user` or `admin`. Everything finer
lives in `RoleAssignment` rows that only a backend function can create, each
carrying an approver and a timestamp. `adult_rider` is the only self-serve role.

Authorization is decided in three places, in this order:

1. **Backend function.** `buildContext()` loads the user, their approved role
   assignments, and their suspension state. Every function checks the role, the
   record ownership, the ride state, and the input before it writes anything.
2. **Entity RLS.** Every entity declares row-level security. Entities a function
   owns deny client `create`, `update`, and `delete` outright, so bypassing the
   function is not possible even with a valid token and a crafted request.
3. **Field-level security.** Exact addresses, coordinates, phone numbers,
   verification codes, operational notes, legal names, dates of birth, licence
   digits, vendor references, and incident narratives carry their own `rls`
   blocks.

A hidden button is not authorization, and neither is a filtered list. The
`schema-integrity` test suite fails the build if any of the 24 function-owned
entities loosens `update` or `delete`.

### Entities that deny all client writes

SystemConfig, LaunchGate, AuditLog, DataRetentionHold, RoleAssignment,
RideRequest, RideNeed, RideOffer, RideAssignment, RideEvent, DriverProfile,
DriverCredential, Vehicle, VehicleCapability, SafetyIncident, IncidentAttachment,
Notification, LegalDocument, LegalAcceptance, Organization, OrganizationMember,
OrganizationParticipantAuthorization, ResourcePartner, ResourceLocation.

AuditLog, RideEvent, and LegalAcceptance additionally deny `create` from clients
and deny `update` and `delete` from everyone, including administrators.

## Specific protections

**Insecure direct object reference.** `reveal-ride-details` and `transition-ride`
resolve the viewer's relationship to the record before responding. Someone with
no relationship gets `404`, not `403`, so the API never confirms that another
person's ride, application, or incident exists.

**Mass assignment.** `stripToAccepted()` allowlists the 19 fields a ride request
may contain. `status`, `fare_charged_cents`, `verification_code`,
`rider_user_id`, and `eligibility_flags` are dropped before the payload is read.
`admin-update-config` and `admin-update-launch-gate` each carry their own
allowlist.

**Race conditions.** `claim-ride` writes a `RideAssignment` with a claim token,
then re-reads every active assignment for that ride and keeps only the earliest.
A losing driver's assignment is deactivated with `lost_claim_race` and the
response says the ride is gone. `assign-ride` refuses outright when an active
assignment exists.

**Enumeration.** Sign-in failures use one message whether or not the account
exists. Ride, application, and incident lookups return `404` for anyone
unrelated to the record.

**Rate limiting.** Ride submission is limited per requester per rolling 24 hours
via `isRateLimited()`, configurable through `ride_request_rate_limit_per_day`.
Identity-code attempts are capped per ride. Notification delivery is
deduplicated by `idempotency_key`, capped per recipient per hour, and backs off
exponentially over at most five attempts before giving up. Milestone 7 extends
rate limiting to authentication, consent links, and tracking links.

**Notification content.** Every body is re-checked against the actual ride
record by `assertNotificationSafe()` immediately before dispatch, not only at
render time. A body that contains an address, phone number, or verification code
is marked `failed` with `redaction_check_failed` and audited rather than sent, so
a future template edit cannot start leaking ride detail.

**Sensitive export.** `export-ride-manifest` is the one endpoint that returns
addresses, phone numbers, and verification codes together, because a dispatcher
with no working app needs all three on paper. It requires a staff role, a written
purpose of at least fifteen characters, and a range of at most 48 hours, and it
writes an `export.sensitive` audit row carrying the purpose, the range, and the
row count.

**File uploads.** Credential documents, vehicle photos, and incident attachments
are stored as private storage references, never as public URLs — a value
starting `http://` or `https://` is rejected outright in
`submit-driver-credential`, `manage-vehicle`, and `attach-incident-evidence`.
`validateUpload()` enforces a per-purpose size ceiling and content-type
allowlist, rejects path traversal and control characters in the filename,
rejects a second extension (`scan.pdf.exe`), and rejects a file whose declared
type disagrees with its extension.

The malware-scanning adapter is defined but no scanner is configured, so
`unavailableScanner` returns `unavailable`, which maps to `pending`.
`mayServeAttachment()` returns true only for `clean`, and
`review-driver-credential` refuses to verify a credential whose document has not
been scanned clean. The absence of a scanner never reads as a clean result.

**Identity verification at pickup.** The rider's rotating six-character code is
never sent to the driver's device — `minimizeRide()` withholds it from every
driver projection, including the assigned driver inside the reveal window. The
driver types what the rider says aloud and the server compares it with
`safeEqual()`. Wrong guesses are capped at five per ride per fifteen minutes,
each attempt is written to `RideEvent` and `AuditLog`, and the failure message
never echoes or hints at the expected value.

**Secrets.** Only in Base44 project secrets, read with `secrets.get()` from
`base44:runtime` inside functions. No key is ever sent to the client. The
frontend holds only `VITE_BASE44_APP_ID`, which is a public identifier.

**Log hygiene.** `redactForLog()` replaces every field on the sensitive list, plus
anything matching `token|secret|password|api_key|ssn|card`, before an audit row or
a console line is written. Function error handlers return a code, never a stack
trace or an internal message.

**Browser storage.** ESLint blocks `localStorage`. No ride, identity, or code is
persisted in the browser.

## What we deliberately do not store

Full Social Security numbers. Full driver's licence numbers — only the last four
digits, the issuing state, and the expiry date. Raw payment card data. Background
check report contents — only a vendor reference, a status, a decision reason
category, and dates. Diagnoses, treatment details, or immigration status.

## Audit

`AuditLog` is append-only to every ordinary user and is written only by the
service role. Audited events include every ride transition, dispatcher decision,
driver credential review, configuration change, launch-gate change, emergency
override, legal acceptance, staff view of a ride, and reveal of exact location.
Denied attempts are audited too, with `outcome: "denied"` and a reason code.

## Not yet done

MFA and step-up authentication for administrators and safety staff, session and
device revocation, admin re-authentication enforced server-side rather than
asserted by the client, a live malware scanner behind the adapter, CSP and
security headers on the hosted site, and a dependency and secret-scanning
pipeline. All are Milestone 7 and are listed as open dependencies in the
milestone report.

## Reporting a vulnerability

Contact the security address configured in admin settings. Do not open a public
issue. We will confirm receipt within two business days.
