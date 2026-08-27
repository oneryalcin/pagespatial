const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const COST_CAVEAT = 'Estimated cost is a placeholder based on the rate recorded when each job was submitted. It is not an invoice or a measured per-job cloud bill.';

const STATUS = Object.freeze({
  uploading: { label: 'Waiting for upload', tone: 'waiting', copy: 'The PDF has not been finalized.' },
  queued: { label: 'Queued', tone: 'queued', copy: 'The upload passed validation and is waiting for dispatch.' },
  dispatched: { label: 'In progress', tone: 'progress', copy: 'The parse call was accepted. Execution may still be queued.' },
  succeeded: { label: 'Succeeded', tone: 'success', copy: 'The validated result is ready.' },
  failed: { label: 'Failed', tone: 'failure', copy: 'The document did not complete.' },
});

const FAILURE_HINTS = Object.freeze({
  upload_expired: 'Submit a new job and upload the PDF within one hour.',
  invalid_upload: 'Submit a PDF with the application/pdf content type.',
  input_digest_mismatch: 'Recalculate the SHA-256 digest and submit a new job.',
  input_too_large: 'Split the PDF into files smaller than 90 MiB.',
  invalid_pdf: 'Check that the file is a valid, supported PDF.',
  page_limit_exceeded: 'Split the PDF into documents of no more than 200 pages.',
  processing_deadline_exceeded: 'Submit the document again. Contact support if this repeats.',
  dispatch_failed: 'Submit the document again. Contact support if this repeats.',
  processing_failed: 'Inspect the source PDF, then submit it again or contact support.',
});

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatCost(micros) {
  if (micros == null) return '—';
  return `$${(number(micros) / 1_000_000).toFixed(3)}`;
}

export function formatTimestamp(value) {
  if (value == null) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const display = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
  }).format(date);
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(display)} UTC</time>`;
}

function shortId(value) {
  const text = String(value);
  return text.length > 8 ? text.slice(0, 8) : text;
}

function status(row) {
  return STATUS[row.state] ?? { label: 'Unknown', tone: 'neutral', copy: 'State is unavailable.' };
}

function statusBadge(row) {
  const item = status(row);
  return `<span class="status status--${item.tone}">${escapeHtml(item.label)}</span>`;
}

function navLink(path, label, active) {
  return `<a href="${path}"${active === path ? ' aria-current="page"' : ''}>${label}</a>`;
}

function accountMenu(identity) {
  return `<details class="account-menu"><summary>${escapeHtml(identity.email)}<span aria-hidden="true"></span></summary><div class="account-panel"><strong>${escapeHtml(identity.email)}</strong><em>Account active</em><dl><dt>Profile</dt><dd>Parse-only v1</dd><dt>Limits</dt><dd>90 MiB · 200 pages · 5 active jobs</dd><dt>Upload window</dt><dd>1 hour</dd><dt>Retention</dt><dd>Inputs and results up to 2 days</dd></dl><div><a href="/guide">API guide</a><a href="/cdn-cgi/access/logout">Sign out</a></div></div></details>`;
}

export function shell({ title, active, identity, content, description = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} · PageSpatial</title>
  ${description ? `<meta name="description" content="${escapeHtml(description)}">` : ''}
  <link rel="stylesheet" href="/dashboard.css">
</head>
<body>
  <a class="skip-link" href="#content">Skip to content</a>
  <header class="site-header">
    <a class="wordmark" href="/jobs" aria-label="PageSpatial home"><img src="/assets/pagespatial-logo.png" alt="PageSpatial"></a>
    <nav class="primary-nav" aria-label="Primary">
      ${navLink('/jobs', 'Jobs', active)}
      ${navLink('/usage', 'Usage', active)}
      ${navLink('/keys', 'API keys', active)}
    </nav>
    <a class="guide-link" href="/guide">API guide</a>
    ${accountMenu(identity)}
    <details class="mobile-nav"><summary><span class="menu-icon" aria-hidden="true"></span><span class="sr-only">Menu</span></summary><nav aria-label="Mobile primary">${navLink('/jobs', 'Jobs', active)}${navLink('/usage', 'Usage', active)}${navLink('/keys', 'API keys', active)}<a href="/guide">API guide</a><span class="mobile-identity">${escapeHtml(identity.email)} · Parse-only v1</span><a href="/cdn-cgi/access/logout">Sign out</a></nav></details>
  </header>
  <main id="content" class="page-shell">${content}</main>
</body>
</html>`;
}

function summaryStrip(label, metrics) {
  return `<section class="summary-strip" aria-label="${escapeHtml(label)} summary"><span class="summary-label">${escapeHtml(label)}</span><span class="summary-divider" aria-hidden="true"></span>${metrics.map(([name, value]) => `<span class="summary-metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(name)}</span></span>`).join('')}</section>`;
}

function filterOption(value, selected, label) {
  return `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`;
}

function formatCompactTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const display = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: 'UTC',
  }).format(date).replace(',', '');
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(display)}</time>`;
}

function dateGroup(value, now) {
  const date = new Date(value);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const prefix = day === today ? 'Today · ' : day === today - 86_400_000 ? 'Yesterday · ' : '';
  return `${prefix}${new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(date)}`;
}

function jobRow(row) {
  return `<tr><td>${statusBadge(row)}</td><td class="mono">${formatCompactTimestamp(row.created_at)}</td><th scope="row"><a class="mono" href="/jobs/${row.id}" title="${row.id}">${escapeHtml(shortId(row.id))}</a></th><td class="numeric">${row.pages_actual == null ? '—' : escapeHtml(row.pages_actual)}</td><td class="numeric">${formatCost(row.estimated_cost_micros)}</td><td class="row-action"><a href="/jobs/${row.id}">View</a></td></tr>`;
}

function jobCard(row) {
  return `<article class="stacked-record"><div>${statusBadge(row)}<span class="mono">${formatCompactTimestamp(row.created_at)} UTC</span></div><p class="mono record-id">${escapeHtml(shortId(row.id))} · ${row.pages_actual == null ? '— pages' : `${escapeHtml(row.pages_actual)} pages`} · ${formatCost(row.estimated_cost_micros)}</p><a class="record-action" href="/jobs/${row.id}">View job</a></article>`;
}

function groupedJobRows(rows, now) {
  let previous = null;
  return rows.map((row) => {
    const group = dateGroup(row.created_at, now);
    const heading = group === previous ? '' : `<tr class="date-group"><th scope="rowgroup" colspan="6">${escapeHtml(group)}</th></tr>`;
    previous = group;
    return `${heading}${jobRow(row)}`;
  }).join('');
}

function queryHref(filters, page) {
  const query = new URLSearchParams({ state: filters.state, date: filters.date, page: String(page) });
  return `/jobs?${query}`;
}

function pagination(filters, page, pageCount) {
  if (pageCount <= 1) return '';
  return `<nav class="pagination" aria-label="Pagination"><a${page <= 1 ? ' aria-disabled="true"' : ` href="${queryHref(filters, page - 1)}"`}>Previous</a><span>Page ${page} of ${pageCount}</span><a${page >= pageCount ? ' aria-disabled="true"' : ` href="${queryHref(filters, page + 1)}"`}>Next</a></nav>`;
}

export function jobsPage({ identity, filters, result, now = new Date() }) {
  const summary = result.summary;
  const hasFilters = filters.state !== 'all' || filters.date !== '7d';
  const rows = groupedJobRows(result.rows, now);
  const cards = result.rows.map(jobCard).join('');
  const empty = result.total === 0
    ? `<section class="empty-state"><h2>${hasFilters ? 'No matching jobs' : 'No jobs yet'}</h2><p>${hasFilters ? 'Change or clear the filters to see other jobs.' : 'Create an API key, then follow the API guide to submit your first PDF.'}</p><div class="button-row">${hasFilters ? '<a class="button button--secondary" href="/jobs">Clear filters</a>' : '<a class="button" href="/keys">Create an API key</a><a class="button button--secondary" href="/guide">Open API guide</a>'}</div></section>`
    : `<div class="data-table jobs-table"><table><caption class="sr-only">Document processing jobs</caption><thead><tr><th scope="col">State</th><th scope="col">Submitted (UTC)</th><th scope="col">Job</th><th class="numeric" scope="col">Pages</th><th class="numeric" scope="col">Est. cost</th><th scope="col"><span class="sr-only">Action</span></th></tr></thead><tbody>${rows}</tbody></table></div><div class="stacked-list">${cards}</div>${pagination(filters, result.page, result.pageCount)}`;
  return shell({
    title: 'Jobs', active: '/jobs', identity,
    description: 'Documents submitted through your PageSpatial API keys.',
    content: `<header class="page-header"><div><h1>Jobs</h1><p>Documents submitted through your API keys.</p></div><a href="/guide">View API guide</a></header>
      ${summaryStrip(filters.date === '7d' ? 'Last 7 days' : filters.date === '24h' ? 'Last 24 hours' : filters.date === '30d' ? 'Last 30 days' : 'All time', [['documents', summary.documents], ['pages completed', summary.pages], ['estimated cost', formatCost(summary.cost)]])}
      <p class="cost-note">${COST_CAVEAT}</p>
      <form class="filters" method="get" action="/jobs"><label>State<select name="state">${filterOption('all', filters.state, 'All states')}${filterOption('active', filters.state, 'Active')}${filterOption('succeeded', filters.state, 'Succeeded')}${filterOption('failed', filters.state, 'Failed')}</select></label><label>Date range<select name="date">${filterOption('24h', filters.date, 'Last 24 hours')}${filterOption('7d', filters.date, 'Last 7 days')}${filterOption('30d', filters.date, 'Last 30 days')}${filterOption('all', filters.date, 'All time')}</select></label><button type="submit">Apply filters</button>${hasFilters ? '<a href="/jobs">Clear filters</a>' : ''}</form>${empty}`,
  });
}

function definition(label, value, extra = '') {
  return `<div><dt>${escapeHtml(label)}</dt><dd${extra}>${value}</dd></div>`;
}

export function jobDetailPage({ identity, row, view, now = new Date() }) {
  const item = status(row);
  const retained = row.state === 'succeeded' && row.retention_expires_at
    && new Date(row.retention_expires_at) > now;
  let outcome = '';
  if (row.state === 'succeeded') {
    outcome = retained
      ? `<section class="result-panel"><div><h2>Result</h2><p>This link is short-lived. You can request another while the result is retained.</p><p>Available until ${formatTimestamp(row.retention_expires_at)}.</p></div><a class="button" href="/jobs/${row.id}/result">Download JSON result</a><p class="small-note">The five-minute bearer URL may appear in browser history.</p></section>`
      : '<section class="notice notice--warning"><h2>Result expired</h2><p>The stored result is no longer available. Submit the source PDF as a new job.</p></section>';
  } else if (row.state === 'failed') {
    const error = view.error ?? { code: 'processing_failed', message: 'Document processing failed.' };
    outcome = `<section class="notice notice--failure"><h2>${escapeHtml(error.message)}</h2><p class="mono">${escapeHtml(error.code)}</p><p>${escapeHtml(FAILURE_HINTS[error.code] ?? FAILURE_HINTS.processing_failed)}</p></section>`;
  }
  return shell({
    title: `Job ${shortId(row.id)}`, active: '/jobs', identity,
    content: `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/jobs">Jobs</a><span aria-hidden="true">/</span><span class="mono">${escapeHtml(shortId(row.id))}</span></nav><header class="page-header job-heading"><div><h1 class="mono">${escapeHtml(row.id)}</h1><p>${escapeHtml(item.copy)}</p></div>${statusBadge(row)}</header><dl class="definition-list">${definition('Processing profile', escapeHtml(view.processing_profile))}${definition('Submitted', formatTimestamp(row.created_at))}${definition('Queued', formatTimestamp(row.queued_at))}${definition('Completed', formatTimestamp(row.completed_at))}${definition('Processing deadline', formatTimestamp(view.processing_deadline_at))}${definition('Input size', view.input_bytes == null ? '—' : `${(view.input_bytes / (1024 * 1024)).toFixed(2)} MiB`)}${definition('Pages', view.pages == null ? '—' : escapeHtml(view.pages))}${definition('Estimated cost', escapeHtml(formatCost(view.estimated_cost_micros)))}${definition('Result retention deadline', formatTimestamp(row.retention_expires_at))}${definition('Input SHA-256', escapeHtml(row.input_digest), ' class="digest"')}</dl><p class="cost-note">${COST_CAVEAT}</p>${outcome}`,
  });
}

export function usagePage({ identity, usage, now = new Date() }) {
  const month = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(now);
  const maxPages = Math.max(1, ...usage.days.map((day) => number(day.pages)));
  const rows = usage.days.map((day) => `<tr><th scope="row"><time datetime="${escapeHtml(day.day)}">${escapeHtml(day.day)} UTC</time></th><td class="numeric">${escapeHtml(day.documents)}</td><td class="numeric">${escapeHtml(day.pages)}</td><td><span class="usage-bar"><span style="width:${Math.round(number(day.pages) / maxPages * 100)}%"></span></span></td><td class="numeric">${formatCost(day.cost)}</td></tr>`).join('');
  const content = rows
    ? `<div class="data-table usage-table"><table><caption class="sr-only">Daily usage for ${escapeHtml(month)}</caption><thead><tr><th scope="col">Day (UTC)</th><th class="numeric" scope="col">Documents</th><th class="numeric" scope="col">Pages</th><th scope="col"><span class="sr-only">Relative pages</span></th><th class="numeric" scope="col">Est. cost</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<section class="empty-state"><h2>No succeeded jobs this month</h2><p>Usage appears after a job succeeds.</p><a class="button button--secondary" href="/guide">Open API guide</a></section>';
  return shell({
    title: 'Usage', active: '/usage', identity,
    content: `<header class="page-header"><div><h1>Usage</h1><p>Succeeded processing recorded for your account.</p></div></header>${summaryStrip('Month to date', [['documents', usage.summary.documents], ['pages completed', usage.summary.pages], ['estimated cost', formatCost(usage.summary.cost)]])}<p class="cost-note">${COST_CAVEAT}</p>${content}`,
  });
}

function keyState(key) {
  return key.revoked_at == null ? '<span class="status status--success">Active</span>' : '<span class="status status--neutral">Revoked</span>';
}

export function keysPage({ identity, keys }) {
  const rows = keys.map((key) => `<tr><th scope="row">${escapeHtml(key.name)}</th><td class="mono">${escapeHtml(key.prefix)}…</td><td class="mono">${formatTimestamp(key.created_at)}</td><td class="mono">${formatTimestamp(key.last_used_at)}</td><td>${keyState(key)}</td><td class="row-action">${key.revoked_at == null ? `<a class="danger-link" href="/keys/${key.id}/revoke">Revoke</a>` : '—'}</td></tr>`).join('');
  return shell({
    title: 'API keys', active: '/keys', identity,
    content: `<header class="page-header"><div><h1>API keys</h1><p>Keys authenticate calls to <span class="mono">api.pagespatial.dev</span>.</p></div><a href="/guide">View API guide</a></header><form class="key-create" method="post" action="/keys"><label>Key name<input name="name" maxlength="64" autocomplete="off" required placeholder="e.g. production-ingest"></label><button type="submit">Create API key</button><p>Use a name that identifies the application or environment. The secret is shown once.</p></form>${rows ? `<div class="data-table keys-table"><table><caption class="sr-only">API keys</caption><thead><tr><th scope="col">Name</th><th scope="col">Prefix</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Action</span></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty-state"><h2>No API keys</h2><p>Create a key to call the API.</p></div>'}`,
  });
}

export function createdKeyPage({ identity, secret }) {
  return shell({
    title: 'API key created', active: '/keys', identity,
    content: `<section class="narrow-page"><nav class="breadcrumbs"><a href="/keys">API keys</a><span aria-hidden="true">/</span><span>created</span></nav><h1>API key created</h1><div class="notice notice--warning"><strong>Copy this key now.</strong><p>It will not be shown again. If you lose it, revoke it and create another.</p></div><pre class="secret"><code>${escapeHtml(secret)}</code></pre><a class="button button--secondary" href="/keys">I have saved the key</a></section>`,
  });
}

export function revokeKeyPage({ identity, key }) {
  return shell({
    title: 'Revoke API key', active: '/keys', identity,
    content: `<section class="narrow-page"><nav class="breadcrumbs"><a href="/keys">API keys</a><span aria-hidden="true">/</span><span>Revoke</span></nav><h1>Revoke API key?</h1><p><strong>${escapeHtml(key.name)}</strong> <span class="mono">${escapeHtml(key.prefix)}…</span></p><p>Requests using this key will stop working immediately. This action cannot be undone.</p><form method="post" action="/keys/${key.id}/revoke"><button class="button--danger" type="submit">Revoke key</button><a class="button button--secondary" href="/keys">Cancel</a></form></section>`,
  });
}

export function guidePage({ identity }) {
  return shell({
    title: 'API guide', active: '', identity,
    content: `<header class="page-header"><div><p class="eyebrow">Quick start</p><h1>API guide</h1><p>Submit a PDF directly to object storage, then let PageSpatial parse it.</p></div></header><ol class="guide-steps"><li><h2>Create an API key</h2><p>Create a key in <a href="/keys">API keys</a> and store the one-time secret securely.</p></li><li><h2>Calculate the PDF digest</h2><pre><code>sha256sum document.pdf</code></pre><p>On macOS, use <code>shasum -a 256 document.pdf</code>.</p></li><li><h2>Create a job</h2><pre><code>curl https://api.pagespatial.dev/v1/jobs \\
  -H "Authorization: Bearer $PAGESPATIAL_API_KEY" \\
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \\
  -H "Content-Type: application/json" \\
  --data '{"input_sha256":"'$PDF_SHA256'"}'</code></pre></li><li><h2>Upload and finalize</h2><p>PUT the PDF to the returned upload URL with <code>Content-Type: application/pdf</code>, then POST an empty JSON object to <code>/v1/jobs/{job_id}/finalize</code>.</p></li><li><h2>Poll and download</h2><p>Poll <code>/v1/jobs/{job_id}</code> until the state is <code>succeeded</code> or <code>failed</code>. A succeeded job includes a result endpoint that returns a five-minute download URL.</p></li></ol><section class="notice"><h2>Service limits</h2><p>5 active jobs per account · 90 MiB per PDF · 200 pages per job · upload within 1 hour · inputs and results retained for up to 2 days.</p></section>`,
  });
}

export function errorPage({ identity, statusCode, message, requestId }) {
  return shell({
    title: statusCode === 404 ? 'Not found' : 'Request failed', active: '', identity,
    content: `<section class="narrow-page error-page"><p class="eyebrow">Error ${statusCode}</p><h1>${escapeHtml(message)}</h1><p>Return to <a href="/jobs">Jobs</a> or try again later.</p><p class="small-note">Request ID: <span class="mono">${escapeHtml(requestId)}</span></p></section>`,
  });
}

export { COST_CAVEAT, escapeHtml };
