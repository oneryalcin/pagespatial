# Product brief: PageSpatial customer dashboard

**Date:** 2026-08-27

**Status:** accepted M3 implementation contract

**Audience:** product designer, UX writer, and implementing engineer

**Parent design:** `docs/design/2026-08-26-service-control-plane.md`
**API guide:** `docs/api-guide.md`

## 1. Product decision

Build a small customer dashboard for the working invite-only PageSpatial API.
The dashboard is an operational window into API usage. It is not a second way
to process documents and it is not an administration console.

The customer should be able to answer four questions without using SQL,
reading logs, or contacting support:

1. What happened to my documents?
2. Where can I download a completed result?
3. How much have I used, and what is the current estimated cost?
4. Which API keys can access my account?

The dashboard must make the service feel dependable and legible. It must not
hide uncertainty behind invented progress indicators.

This brief makes one deliberate simplification to the parent M3 outline: it
removes the standalone Account page. Email, service limits, the API guide, and
sign out fit in the application shell; they do not justify another primary
destination.

## 2. Product boundary

### In M3

- A server-rendered dashboard protected by Cloudflare Access.
- A jobs timeline and a job-detail view.
- A usage summary based on succeeded job rows.
- API-key creation, one-time secret display, listing, and revocation.
- Clear empty, loading, failure, expired, and unavailable states.
- Responsive layouts for desktop and mobile.

### Not in M3

- Browser PDF upload.
- Self-serve signup or invitations.
- Payments, invoices, credits, or Stripe.
- Teams, organizations, roles, or shared projects.
- Document previews or an embedded result viewer.
- Progressive page results or an invented percentage complete.
- Enrichment controls.
- Notifications, webhooks, or email delivery.
- Job cancellation or retry buttons.
- A SPA, client-side router, frontend framework, bundler, or chart library.
- A general design system package.

These omissions are deliberate. The dashboard serves API customers. The API
remains the document-submission surface.

### Accepted progressive enhancements

The visual work may retain job search and keyboard-shortcut concepts such as
`Cmd/Ctrl+K`, `g j`, `g u`, `g k`, and `?`. They are useful candidate
enhancements, but they do not block M3 and must not appear as working controls
until their routes, behavior, accessibility, and tests exist. The M3 core
journey remains fully usable without JavaScript.

### Sign-in ownership

Cloudflare Access owns authentication before a request reaches the dashboard.
For M3, its hosted login and one-time PIN flow is the proper sign-in surface;
brand that page through Cloudflare rather than adding an unreachable
dashboard-origin sign-in page. PageSpatial begins at the authenticated
dashboard shell.

A future public marketing or signup page may link to the protected dashboard,
and a future self-serve account product may justify a different identity
architecture. Neither is part of M3.

## 3. Users and primary journey

The initial user is a technical operator or developer at an invited design
partner. They already have access to `app.pagespatial.dev` and may already
have an API key.

Primary journey:

```text
Sign in with Cloudflare Access
             |
             v
See recent jobs and current service state
             |
      +------+------+
      |             |
      v             v
Inspect a job    Manage API keys
      |
      v
Download a completed JSON result
```

The first-session journey is different:

```text
No jobs yet
    |
    +--> create an API key
    |
    +--> open the API guide
    |
    +--> submit the first PDF from the command line
```

The dashboard does not pretend that key creation is document submission.

## 4. Information architecture

Three top-level destinations are enough:

| Navigation item | Route | Purpose |
| --- | --- | --- |
| Jobs | `/jobs` | Recent and active document processing |
| Usage | `/usage` | Pages and estimated cost over time |
| API keys | `/keys` | Create, inspect, and revoke credentials |

Additional routes:

| Route | Purpose |
| --- | --- |
| `/` | Redirect to `/jobs` |
| `/jobs/{job_id}` | One job's state, timestamps, error, and result action |

The job-detail route is subordinate to Jobs; it is not another navigation
item.

## 5. Global application shell

### Desktop

- Narrow left navigation or compact top navigation. Do not use both.
- PageSpatial wordmark at the start of navigation.
- Current page is visible without relying on colour alone.
- Signed-in email and sign out live in a compact shell menu or navigation
  footer, not a separate product area.
- A small `API guide` link is persistent in the shell.
- Main content has a readable maximum width, but jobs tables can use the full
  available width.

### Mobile

- One compact header with product name and a native, accessible navigation
  disclosure.
- Tables become stacked records; do not require horizontal scrolling for the
  primary fields.
- Primary actions remain full-width and easy to tap.

### Visual character

PageSpatial is an evidence system, not a generic AI assistant. The interface
should feel precise, calm, and technical:

- the Ivory Ledger direction: warm off-white canvas with light ivory data
  surfaces;
- dark graphite text;
- one restrained sage, teal, or blue-green action colour, kept distinct from
  failure red;
- thin neutral borders and modest corner radii;
- compact data presentation with generous section spacing;
- system fonts by default; permissively licensed fonts may be bundled and
  served locally when they materially improve the design;
- no gradients, glass effects, glowing cards, mascots, or AI sparkles;
- no decorative illustrations on operational pages.

Use colour as reinforcement only. Every status also needs a word and, where
useful, an icon.

## 6. Shared component vocabulary

These are implementation-level view components, not a framework:

```text
PageShell
PageHeader
PrimaryNav
Breadcrumbs
StatusBadge
MetricCard
DataTable
StackedRecordList
EmptyState
InlineNotice
DefinitionList
Pagination
SecretReveal
DangerAction
```

Each component accepts plain data and returns HTML. Components do not fetch
data or own business rules. Route handlers query tenant-scoped data, build a
small view model, and pass it to render functions.

The names should remain boring and literal. Do not introduce a polymorphic
component system or a page-builder abstraction.

## 7. Jobs page

### Goal

Show what the customer's API calls produced and make the next action obvious.

### Header

- Title: `Jobs`
- Supporting text: `Documents submitted through your API keys.`
- Secondary link: `View API guide`
- No `New job` button because the dashboard cannot submit a document.

### Summary row

Three small metrics, computed from the currently selected date range:

- `Documents`
- `Pages completed`
- `Estimated cost`

Do not add success-rate or average-duration metrics until users ask for them.

### Filters

- State: `All`, `Active`, `Succeeded`, `Failed`
- Date: `Last 24 hours`, `Last 7 days`, `Last 30 days`, `All time`
- Apply using ordinary GET query parameters.
- The URL is shareable and browser Back works.
- Default: all states, last 7 days.

`Active` means the internal states `uploading`, `queued`, or `dispatched`.

### Desktop table

Newest first, 25 rows per page:

| Column | Rule |
| --- | --- |
| Job | Short display form of the job UUID; full value on detail page |
| State | Human label using `StatusBadge` |
| Submitted | Explicit UTC date and time |
| Pages | Actual pages or an em dash before completion |
| Estimated cost | Integer micros formatted as USD; em dash until known |
| Action | `View` link only |

Do not expose attempts, Modal call ids, R2 keys, internal error text, or the
input digest in the list.

### Mobile record

Each record shows:

1. state and submitted time;
2. short job id;
3. pages and estimated cost when known;
4. a single `View job` link.

### Empty state

Title: `No jobs yet`

Body: `Create an API key, then submit your first PDF using the API guide.`
Actions: `Manage API keys` and `Open API guide`.

If filters remove all rows, use `No jobs match these filters` and a `Clear
filters` link instead. Do not show the first-use onboarding copy.

## 8. Job-detail page

### Header

- Breadcrumb: `Jobs / {short job id}`
- Full state badge.
- Full job UUID in selectable monospace text.
- Do not add a copy button unless JavaScript is later justified.

### Primary state panel

Show one truthful state message:

| Internal state | Public label | Explanation |
| --- | --- | --- |
| `uploading` | Waiting for upload | `The PDF has not been finalized.` |
| `queued` | Queued | `The upload passed validation and is waiting for dispatch.` |
| `dispatched` | In progress | `The parse call was accepted. Execution may still be queued.` |
| `succeeded` | Succeeded | `The validated result is ready.` |
| `failed` | Failed | Use the typed, public-safe failure message |

Never show a percentage, moving progress bar, page counter, or ETA. The
system does not measure them.

For non-terminal jobs, show `Processing deadline` if available. This tells
the user when the service will stop waiting without exposing reconciler
internals.

### Result action

For a succeeded, retained result:

- Primary button: `Download JSON result`
- Supporting text: `This link is short-lived. You can request another while
  the result is retained.`
- Retention line: `Available until {date and time}`

The button uses `GET /jobs/{job_id}/result`, a new tenant-scoped dashboard
route that calls the same `resultGrant` implementation as the API and
redirects to its presigned URL. Do not fork the grant rules. The route is
idempotent and needs no CSRF token. The API key is never placed in the
object-storage URL. The presigned bearer URL may appear in browser history;
this is accepted for v1 because the grant expires within five minutes.

For an expired result:

- Notice: `This result is no longer available.`
- Explanation: `Inputs and results are retained for up to two days.`
- No fake retry action. Resubmission occurs through the API.

### Details

Use a definition list, not a card for every field:

- Processing profile
- Submitted
- Queued
- Completed
- Input size
- Pages
- Estimated cost
- Input SHA-256
- Processing deadline
- Result retention deadline

Hide null timestamps instead of rendering a wall of `Not available` values.

### Failure treatment

Use the typed failure code to choose the safe public message already defined
by the API. Add one actionable hint only where the action is real:

| Failure | Hint |
| --- | --- |
| `upload_expired` | `Submit the document again with a new job.` |
| `input_too_large` | `Split or reduce the PDF, then submit it again.` |
| `input_digest_mismatch` | `Recompute the SHA-256 and submit a new job.` |
| `page_limit_exceeded` | `Split the PDF into documents of 200 pages or fewer.` |
| `invalid_pdf` / `invalid_upload` | `Check that the input is a valid PDF.` |
| deadline, dispatch, processing failures | `You can submit a new job. Contact support if the problem repeats.` |

Do not show exception strings, stacks, worker ids, or provider errors.

## 9. Usage page

### Goal

Give a transparent operational estimate, not a billing product.

### Header

- Title: `Usage`
- Supporting text: `Succeeded processing recorded for your account.`

### Month-to-date metrics

- Documents succeeded
- Pages completed
- Estimated cost

The cost label and caveat must remain adjacent:

> Estimated cost is a placeholder based on the rate recorded when each job
> was submitted. It is not an invoice or a measured per-job cloud bill.

### Daily history

Show the last 30 days as an accessible table. A small CSS-only bar treatment
may reinforce page counts, but the numbers and dates must remain readable
without colour or graphics.

Columns:

- Date
- Succeeded documents
- Pages
- Estimated cost

Do not add plan limits, credits, invoices, forecasts, savings claims, or cost
breakdowns by provider.

### Empty state

`Usage appears after your first job completes.`

## 10. API keys page

The security contract already exists and must survive the redesign.

### Header

- Title: `API keys`
- Supporting text: `Keys authenticate calls to api.pagespatial.dev.`
- Link: `View API guide`

### Create form

- One field: `Key name`
- Helper: `Use a name that identifies the application or environment.`
- Maximum 64 Unicode code points.
- Submit: `Create API key`

Do not ask for scopes. All v1 keys have the same service access.

### One-time secret page

This is a dedicated success state, not a transient toast:

- Title: `API key created`
- Warning: `Copy this key now. It will not be shown again.`
- Secret in selectable, wrapping monospace text.
- Advice: `Store it in a secret manager. Do not put it in source control,
  logs, URLs, or chat messages.`
- Action: `I have saved the key`

Do not persist plaintext merely to support refresh or a copy interaction.

### Key list

Active keys first, then revoked keys:

- Name
- Prefix
- Created
- Last used
- Status
- Revoke action for active keys only

Revocation needs a confirmation page or native confirmation pattern that
works without client-side JavaScript. Copy should state that revocation is
immediate and cannot be undone.

Never display the hash or reconstruct a secret.

## 11. Account controls

Do not create a standalone Account page. It adds navigation without enabling a
new customer task. Put these facts in a compact shell menu, footer panel, or
small help disclosure:

- Signed-in email
- Account status: `Active`
- Service profile: `Parse-only v1`
- Limits: 90 MiB, 200 pages, 5 active jobs
- Upload/finalize window: one hour
- Retention: inputs and results up to two days
- Link to API guide
- `Sign out` action through Cloudflare Access

Do not show editable profile fields, password controls, invitation management,
plans, or payment settings.

## 12. Status and visual semantics

Recommended labels and tones:

| State | Tone | Icon idea |
| --- | --- | --- |
| Waiting for upload | neutral | upload arrow |
| Queued | neutral-blue | clock |
| In progress | blue | static dot or clock, not a spinner |
| Succeeded | green | check |
| Failed | red | warning mark |

Do not animate a processing badge continuously. Animation suggests measured
progress and creates accessibility noise.

All badges need sufficient contrast and visible text. Never encode status
only with red, amber, or green.

## 13. Error and service-unavailable states

Dashboard errors use a consistent full-page or inline treatment:

- Plain-language title.
- One sentence describing what the user can do.
- Request id when one exists.
- `Try again` as a normal link for safe GET requests.
- No technical diagnostic text.

Examples:

- `We could not load your jobs. Try again.`
- `The result service is temporarily unavailable. Your job record is safe.`
- `Access denied.`

A database or provider outage must not render a fake empty state.

## 14. Accessibility requirements

- Target WCAG 2.2 AA.
- One `h1` per page and logical heading order.
- A keyboard-visible skip link.
- Every form field has a persistent label.
- Validation errors are associated with their field and summarized near the
  page heading.
- Tables have headers and captions; mobile cards preserve the same labels.
- Focus is visible with at least a two-pixel outline.
- Minimum pointer target is 44 by 44 CSS pixels where practical.
- Status, errors, and selection do not rely on colour alone.
- Dates use readable text; exact timestamps may use `time[datetime]`.
- Secret text wraps without causing horizontal page overflow.
- Reduced-motion preferences are respected; the first release needs no
  motion.

## 15. Responsive behavior

Design at three representative widths:

- 1440 px desktop
- 768 px tablet
- 390 px mobile

The implementation should use content-driven breakpoints rather than device
detection.

On narrow screens:

- navigation collapses;
- summary metrics stack or form a two-column grid;
- filters stack with full-width controls;
- data tables become labelled records;
- buttons do not become icon-only;
- long ids and digests wrap or scroll inside their own code container.

## 16. Implementation constraints for the designer

The design must work within these deliberate constraints:

- Node server-rendered HTML.
- One self-hosted CSS file.
- No JavaScript required for the core journey.
- No runtime dependency on externally hosted fonts, analytics, images, or CSS
  frameworks. Any selected font files are bundled and served locally.
- Strict Content Security Policy and `Cache-Control: no-store`.
- Dashboard identity comes only from verified Cloudflare Access JWTs.
- Every database query is scoped to the signed-in user.
- Mutating forms use POST, exact Origin validation, and redirect after
  non-secret mutations.
- API and dashboard remain on separate hostnames.

A designer may propose progressive enhancement, but the brief must remain
fully usable without it.

## 17. Data and formatting rules

- Store and compute money as integer micros; format only at render time.
- Render cost as USD with enough precision for small values. For example,
  `3000` micros is `$0.003`, not `$0.00`.
- Baseline rendering uses UTC and labels it explicitly. Use semantic
  `time[datetime]` markup with the exact ISO timestamp. Viewer-local dates are
  allowed only as progressive enhancement because the server does not know
  the viewer's timezone.
- Use binary units for input size: KiB and MiB.
- Use an em dash for a value that does not exist yet; reserve `0` for a real
  zero.
- Never infer progress from elapsed time.
- Never parse internal error strings to produce customer copy.
- Never recompute historical estimated cost using today's configured rate.

## 18. Low-fidelity layout

An illustrative visual direction is available at
[`assets/2026-08-27-dashboard-jobs-concept-v2.png`](assets/2026-08-27-dashboard-jobs-concept-v2.png).
It demonstrates density, hierarchy, and tone only. Example values and any
detail that conflicts with this written contract are not requirements. The
illustrated `25 per page` selector is not a feature: M3 uses a fixed 25 rows
per page with previous and next navigation.

```text
+--------------------------------------------------------------------------+
| PageSpatial    Jobs   Usage   API keys       API guide   jane@... / Exit |
+--------------------------------------------------------------------------+
| Jobs                                                                     |
| Documents submitted through your API keys.                              |
|                                                                          |
| [ Documents 18 ] [ Pages 642 ] [ Estimated cost $0.642 ]                 |
|                                                                          |
| State [All v]     Date [Last 7 days v]                                   |
|                                                                          |
| STATE       SUBMITTED          PAGES     COST       JOB           ACTION |
| In progress 27 Aug, 12:31 UTC  —         —          7ab2...       View   |
| Succeeded   27 Aug, 11:02 UTC  50        $0.050     f120...       View   |
| Failed      26 Aug, 18:44 UTC  —         —          8cd3...       View   |
|                                                                          |
|                                                        [Previous] [Next] |
+--------------------------------------------------------------------------+
```

Job detail:

```text
Jobs / f120...

[Succeeded]  f120cd4e-....
The validated result is ready.

[ Download JSON result ]
Available until 29 Aug 2026, 11:04

Details
Submitted              27 Aug 2026, 11:02 UTC
Completed              27 Aug 2026, 11:04 UTC
Pages                   50
Estimated cost          $0.050
Input size              18.4 MiB
Processing profile      parse-v1
```

## 19. Designer deliverables

The UX designer should return:

1. Desktop and mobile designs for Jobs, Job detail, Usage, API keys, key
   created, and the compact account/sign-out treatment.
2. Empty, filtered-empty, active, succeeded, failed, expired-result, and
   service-unavailable states.
3. A small token sheet: colour, type scale, spacing, borders, radii, focus,
   and status treatments.
4. Component specifications for the shared vocabulary in section 6.
5. Accessibility annotations for navigation, tables, forms, errors, and
   secret handling.
6. Exact final UI copy, with any proposed change to this brief called out.

The designer should not add product areas that are in section 2's non-goals.
Any addition must answer: what real user action becomes possible?

## 20. Acceptance criteria

M3 is complete when:

1. An invited user can navigate all three areas with keyboard only.
2. Jobs are tenant-scoped, newest first, filterable, and paginated.
3. Every internal job state has a truthful public presentation.
4. A succeeded retained job provides a fresh result download.
5. A failed job shows only its typed public error and a valid next action.
6. Month-to-date pages and estimated cost equal the sum of that user's
   succeeded job rows.
7. Historical costs do not change when the configured rate changes.
8. API-key plaintext appears only in the one creation response.
9. Revocation is tenant-scoped, explicit, and irreversible.
10. Empty and outage states cannot be confused.
11. Desktop and mobile layouts pass the agreed accessibility review.
12. The implementation introduces no new job lifecycle or public API.

The M3 database migration must add a tenant timeline index equivalent to
`jobs (user_id, created_at DESC)`. Existing partial indexes serve active-job
coordination; they do not serve the paginated customer timeline.

## 21. Product questions to learn from real use

The dashboard should help us observe, not prematurely answer:

- Do customers return to inspect jobs, or do they rely entirely on the API?
- Is downloading raw JSON sufficient, or is an evidence viewer the next real
  product need?
- Which failures create support requests?
- Do users understand the estimated-cost caveat?
- Do users need browser upload, or is API-only intake correct?
- Is two-day result retention adequate?

Those answers should determine M4. They should not be guessed into M3.
