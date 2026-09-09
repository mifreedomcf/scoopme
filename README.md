# Scoop Me

Free, scheduled community rides. Residents who lack reliable transportation are
matched with screened volunteer drivers so they can reach food, supplies, social
services, education programs, and non-emergency appointments.

**Riders are never charged.** No fare, booking fee, subscription, surge price, or
required contribution. Whether someone donates, volunteers, or brings supplies has
no effect on eligibility, priority, matching, service quality, or access. That is
enforced in the data model (`RideRequest.fare_charged_cents` has `maximum: 0`) and
in the request allowlist, not only in copy.

This repository is **Milestone 1: closed adult pilot foundation**. Ride fulfilment
is switched off and cannot be switched on until the compliance launch gate is
complete. See `LEGAL-INSURANCE-LAUNCH-GATES.md`.

---

## Status and honest limits

- Nothing here is legally reviewed. Every policy document ships as
  `draft_requires_review` and renders a visible DRAFT banner.
- The operator is `Pilot Operator — To Be Confirmed` until an administrator types
  a real name in admin settings. No partner is represented as operator, carrier,
  insurer, employer, agent, or guarantor.
- The geocoder runs in mock mode. The Detroit boundary shipped in `geo.ts` is a
  **coarse placeholder** used only to reject obviously-outside points. It can
  never mark a point as inside the service area. Until a real boundary and a live
  geocoder are configured, every request is flagged for a dispatcher.
- Background checks run in `mock_pending_review`. The mock never returns a
  passing result, so no driver can be approved through it.
- The pilot partner listing has a name and a ZIP and nothing else. Address,
  hours, contact, pickup instructions, inventory notes, and public description
  are deliberately blank for an administrator to fill in from the partner.

## Architecture

```
base44/
  config.jsonc              project config (entities, functions, site)
  auth/config.jsonc         login methods
  entities/*.jsonc          29 entity schemas with row- and field-level security
  shared/*.ts               pure decision logic + one SDK seam (runtime.ts)
  functions/<name>/entry.ts 14 Deno serverless functions
src/                        React + Vite frontend
tests/                      90 Vitest tests over the decision logic and schemas
```

**Base44 services used:** managed entity database with RLS/FLS, Deno backend
functions, auth (password + Google), project secrets, site hosting.

**The design rule that shapes everything:** entity RLS denies client writes on
every entity a backend function owns. The frontend cannot set a ride status, a
role, a credential, an eligibility flag, or a config value — those writes are
refused at the database, so routing through a function is the only path, and the
function re-checks authorization, role, record ownership, ride state, geography,
and input on every call.

`base44/shared/` holds the decisions and imports nothing from npm, so the same
code that runs in production is what the test suite exercises. `runtime.ts` is
the single module that touches the SDK.

## Backend functions

| Function | What it decides |
|---|---|
| `get-app-config` | Public projection of branding and effective flags. No secrets, no gate evidence. |
| `submit-ride-request` | Allowlists input, re-derives geography server-side, rate limits, writes the request. |
| `transition-ride` | The only path that changes `RideRequest.status`. Runs the state machine. |
| `dispatcher-review-ride` | Human approval, then deterministic matching and minimized offers. |
| `claim-ride` | Driver claim under a lock. Re-checks live credential state. |
| `assign-ride` | Dispatcher assignment, same lock, same eligibility filters. |
| `reveal-ride-details` | The only ride read path. Time-boxed reveal, audited. |
| `driver-application-submit` | Age gates, acknowledgements, creates pending checks. |
| `driver-application-review` | Reviewer decision. Blocks self-review and incomplete credentials. |
| `admin-update-config` | Gate-checked, floor-checked flag writes with override audit. |
| `admin-update-launch-gate` | Gate updates with evidence, reviewer, and separation of duties. |
| `accept-legal-document` | Records acceptance of a specific published version. |
| `list-driver-offers` | Minimized open offers. Returns nothing to an ineligible driver. |
| `seed-pilot-data` | Idempotent seeding. Leaves unknown partner details blank. |

## Getting started

```bash
npm install
npx base44@latest login
npx base44@latest link            # or `create` for a new app
cp base44/.app.jsonc.example base44/.app.jsonc   # then paste your app id
cp .env.example .env              # set VITE_BASE44_APP_ID

npx base44@latest entities push
npx base44@latest functions deploy
npx base44@latest auth push

npm run dev
```

Then sign in as a Base44 admin and call `seed-pilot-data`.

The Base44 CLI is invoked with `npx` rather than installed as a devDependency,
because it resolves part of its dependency tree from the JSR registry, which some
networks block.

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Type check, then production build |
| `npm test` | Vitest suite |
| `npm run lint` | ESLint, including `jsx-a11y` |
| `npm run b44:deploy` | Deploy entities, functions, auth, and site |

## Environment

Names only; values live in Base44 project secrets. See `.env.example`.

`VITE_BASE44_APP_ID` (frontend), `GEOCODER_PROVIDER`, `GEOCODER_API_KEY`,
`NOTIFY_EMAIL_PROVIDER`, `NOTIFY_SMS_PROVIDER`, `NOTIFY_SMS_ACCOUNT_SID`,
`NOTIFY_SMS_AUTH_TOKEN`, `NOTIFY_SMS_FROM`, `BACKGROUND_CHECK_PROVIDER`,
`BACKGROUND_CHECK_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

Every one of these has a disabled state that fails safe. Nothing fakes a
successful check or payment when a credential is missing.

## Design

The interface borrows from municipal transit signage: high-contrast wayfinding,
wide colour bands that carry status rather than decorate, and one bold element —
the route strip that shows where a ride is along its journey. The type stack is
system UI on purpose, so there is no webfont payload on an old phone on a weak
connection. Touch targets are 52px, focus is always visible, motion respects
`prefers-reduced-motion`, and forms have error summaries that link to the field.

## What is not built yet

Milestones 2–7: credential automation and expiry jobs, organization scheduling
UI, the guardian/minor workflow (architected, flag-disabled), maps and consented
live tracking, donations and the tip ledger, and production hardening.

## Related documents

`SECURITY.md` · `PRIVACY-DATA-MAP.md` · `THREAT-MODEL.md` · `PILOT-RUNBOOK.md` ·
`LEGAL-INSURANCE-LAUNCH-GATES.md`
