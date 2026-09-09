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
Notifications are deduplicated by `idempotency_key`. Milestone 7 extends this to
authentication, driver claims, consent links, tracking links, messages,
donations, and incident submissions.

**File uploads.** Credential documents and incident attachments are stored as
private storage references (`UploadPrivateFile`), never as public URLs. A signed
URL is minted per access request and that access is audited.
`IncidentAttachment.scan_status` starts at `pending`; the malware-scanning
adapter lands in Milestone 2, and an unscanned attachment is not served.

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
asserted by the client, the malware-scanning adapter, CSP and security headers on
the hosted site, and a dependency and secret-scanning pipeline. All are Milestone
7 and are listed as open dependencies in the milestone report.

## Reporting a vulnerability

Contact the security address configured in admin settings. Do not open a public
issue. We will confirm receipt within two business days.
