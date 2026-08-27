const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const COST_CAVEAT = 'Estimated cost is a placeholder based on the rate recorded when each job was submitted. It is not an invoice or a measured per-job cloud bill.';

const STATUS = Object.freeze({
  uploading: { label: 'Waiting for upload', tone: 'queued', copy: 'The PDF upload has not been finalized.' },
  queued: { label: 'Queued', tone: 'queued', copy: 'The document is waiting for processing capacity.' },
  dispatched: { label: 'In progress', tone: 'progress', copy: 'The job was sent for processing. Execution may still be queued.' },
  succeeded: { label: 'Succeeded', tone: 'success', copy: 'The result is ready.' },
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
  return text.length > 13 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
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
  return `<details class="account-menu"><summary>${escapeHtml(identity.email)}</summary><div class="account-panel"><strong>Service limits</strong><span>5 active jobs</span><span>90 MiB per PDF</span><span>200 pages per job</span><span>1 hour to upload</span><a href="/cdn-cgi/access/logout">Sign out</a></div></details>`;
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
    <a class="wordmark" href="/jobs" aria-label="PageSpatial home"><span aria-hidden="true"></span>PageSpatial</a>
    <nav class="primary-nav" aria-label="Primary">
      ${navLink('/jobs', 'Jobs', active)}
      ${navLink('/usage', 'Usage', active)}
      ${navLink('/keys', 'API keys', active)}
      <a href="/guide">API guide</a>
    </nav>
    ${accountMenu(identity)}
    <details class="mobile-nav"><summary>Menu</summary><nav aria-label="Mobile primary">${navLink('/jobs', 'Jobs', active)}${navLink('/usage', 'Usage', active)}${navLink('/keys', 'API keys', active)}<a href="/guide">API guide</a><a href="/cdn-cgi/access/logout">Sign out</a></nav></details>
  </header>
  <main id="content" class="page-shell">${content}</main>
  <footer class="site-footer"><span>PageSpatial parse API</span><span>All times shown in UTC</span></footer>
</body>
</html>`;
}

function metric(label, value, detail = '') {
  return `<section class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</section>`;
}

function filterOption(value, selected, label) {
  return `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`;
}

function jobRow(row) {
  return `<tr><th scope="row"><a class="mono" href="/jobs/${row.id}" title="${row.id}">${escapeHtml(shortId(row.id))}</a></th><td>${statusBadge(row)}</td><td>${formatTimestamp(row.created_at)}</td><td>${row.pages_actual == null ? '—' : escapeHtml(row.pages_actual)}</td><td>${formatCost(row.estimated_cost_micros)}</td><td><a href="/jobs/${row.id}">View</a></td></tr>`;
}

function jobCard(row) {
  return `<article class="stacked-record"><div>${statusBadge(row)}<span>${formatTimestamp(row.created_at)}</span></div><a class="mono record-id" href="/jobs/${row.id}">${escapeHtml(shortId(row.id))}</a><dl><div><dt>Pages</dt><dd>${row.pages_actual == null ? '—' : escapeHtml(row.pages_actual)}</dd></div><div><dt>Estimated cost</dt><dd>${formatCost(row.estimated_cost_micros)}</dd></div></dl></article>`;
}

function queryHref(filters, page) {
  const query = new URLSearchParams({ state: filters.state, date: filters.date, page: String(page) });
  return `/jobs?${query}`;
}

function pagination(filters, page, pageCount) {
  if (pageCount <= 1) return '';
  return `<nav class="pagination" aria-label="Pagination"><a${page <= 1 ? ' aria-disabled="true"' : ` href="${queryHref(filters, page - 1)}"`}>Previous</a><span>Page ${page} of ${pageCount}</span><a${page >= pageCount ? ' aria-disabled="true"' : ` href="${queryHref(filters, page + 1)}"`}>Next</a></nav>`;
}

export function jobsPage({ identity, filters, result }) {
  const summary = result.summary;
  const hasFilters = filters.state !== 'all' || filters.date !== '7d';
  const rows = result.rows.map(jobRow).join('');
  const cards = result.rows.map(jobCard).join('');
  const empty = result.total === 0
    ? `<section class="empty-state"><h2>${hasFilters ? 'No matching jobs' : 'No jobs yet'}</h2><p>${hasFilters ? 'Change or clear the filters to see other jobs.' : 'Create an API key, then follow the API guide to submit your first PDF.'}</p><div class="button-row">${hasFilters ? '<a class="button button--secondary" href="/jobs">Clear filters</a>' : '<a class="button" href="/keys">Create an API key</a><a class="button button--secondary" href="/guide">Open API guide</a>'}</div></section>`
    : `<div class="data-table"><table><caption class="sr-only">Document processing jobs</caption><thead><tr><th scope="col">Job</th><th scope="col">State</th><th scope="col">Submitted</th><th scope="col">Pages</th><th scope="col">Estimated cost</th><th scope="col"><span class="sr-only">Action</span></th></tr></thead><tbody>${rows}</tbody></table></div><div class="stacked-list">${cards}</div>${pagination(filters, result.page, result.pageCount)}`;
  return shell({
    title: 'Jobs', active: '/jobs', identity,
    description: 'Documents submitted through your PageSpatial API keys.',
    content: `<header class="page-header"><div><p class="eyebrow">Operations</p><h1>Jobs</h1><p>Documents submitted through your API keys.</p></div><a href="/guide">View API guide</a></header>
      <section class="metrics" aria-label="Selected period summary">${metric('Documents', summary.documents)}${metric('Pages completed', summary.pages)}${metric('Estimated cost', formatCost(summary.cost))}</section>
      <p class="cost-note">${COST_CAVEAT}</p>
      <form class="filters" method="get" action="/jobs"><label>State<select name="state">${filterOption('all', filters.state, 'All')}${filterOption('active', filters.state, 'Active')}${filterOption('succeeded', filters.state, 'Succeeded')}${filterOption('failed', filters.state, 'Failed')}</select></label><label>Date<select name="date">${filterOption('24h', filters.date, 'Last 24 hours')}${filterOption('7d', filters.date, 'Last 7 days')}${filterOption('30d', filters.date, 'Last 30 days')}${filterOption('all', filters.date, 'All time')}</select></label><button type="submit">Apply</button>${hasFilters ? '<a href="/jobs">Clear</a>' : ''}</form>${empty}`,
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
      ? `<section class="result-panel"><div><h2>Result</h2><p>The result is available until ${formatTimestamp(row.retention_expires_at)}.</p></div><a class="button" href="/jobs/${row.id}/result">Download JSON</a><p class="small-note">The download link is a five-minute bearer URL and may appear in browser history.</p></section>`
      : '<section class="notice notice--warning"><h2>Result expired</h2><p>The stored result is no longer available. Submit the source PDF as a new job.</p></section>';
  } else if (row.state === 'failed') {
    const error = view.error ?? { code: 'processing_failed', message: 'Document processing failed.' };
    outcome = `<section class="notice notice--failure"><h2>${escapeHtml(error.message)}</h2><p class="mono">${escapeHtml(error.code)}</p><p>${escapeHtml(FAILURE_HINTS[error.code] ?? FAILURE_HINTS.processing_failed)}</p></section>`;
  }
  return shell({
    title: `Job ${shortId(row.id)}`, active: '/jobs', identity,
    content: `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/jobs">Jobs</a><span aria-hidden="true">/</span><span>Job detail</span></nav><header class="page-header job-heading"><div><p class="eyebrow">Job</p><h1 class="mono">${escapeHtml(row.id)}</h1><p>${escapeHtml(item.copy)}</p></div>${statusBadge(row)}</header><dl class="definition-list">${definition('Submitted', formatTimestamp(row.created_at))}${definition('Queued', formatTimestamp(row.queued_at))}${definition('Completed', formatTimestamp(row.completed_at))}${definition('Processing deadline', formatTimestamp(view.processing_deadline_at))}${definition('Pages', view.pages == null ? '—' : escapeHtml(view.pages))}${definition('Input size', view.input_bytes == null ? '—' : `${(view.input_bytes / (1024 * 1024)).toFixed(2)} MiB`)}${definition('Estimated cost', escapeHtml(formatCost(view.estimated_cost_micros)))}${definition('Processing profile', escapeHtml(view.processing_profile))}</dl><p class="cost-note">${COST_CAVEAT}</p>${outcome}`,
  });
}

export function usagePage({ identity, usage, now = new Date() }) {
  const month = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(now);
  const rows = usage.days.map((day) => `<tr><th scope="row"><time datetime="${escapeHtml(day.day)}">${escapeHtml(day.day)} UTC</time></th><td>${escapeHtml(day.documents)}</td><td>${escapeHtml(day.pages)}</td><td>${formatCost(day.cost)}</td></tr>`).join('');
  const content = rows
    ? `<div class="data-table"><table><caption class="sr-only">Daily usage for ${escapeHtml(month)}</caption><thead><tr><th scope="col">Day</th><th scope="col">Documents</th><th scope="col">Pages</th><th scope="col">Estimated cost</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<section class="empty-state"><h2>No succeeded jobs this month</h2><p>Usage appears after a job succeeds.</p><a class="button button--secondary" href="/guide">Open API guide</a></section>';
  return shell({
    title: 'Usage', active: '/usage', identity,
    content: `<header class="page-header"><div><p class="eyebrow">Current month</p><h1>Usage</h1><p>Succeeded jobs in ${escapeHtml(month)}.</p></div></header><section class="metrics">${metric('Documents', usage.summary.documents)}${metric('Pages completed', usage.summary.pages)}${metric('Estimated cost', formatCost(usage.summary.cost))}</section><p class="cost-note">${COST_CAVEAT}</p>${content}`,
  });
}

function keyState(key) {
  return key.revoked_at == null ? '<span class="status status--success">Active</span>' : '<span class="status status--neutral">Revoked</span>';
}

export function keysPage({ identity, keys }) {
  const rows = keys.map((key) => `<tr><th scope="row">${escapeHtml(key.name)}</th><td class="mono">${escapeHtml(key.prefix)}…</td><td>${keyState(key)}</td><td>${formatTimestamp(key.created_at)}</td><td>${formatTimestamp(key.last_used_at)}</td><td>${key.revoked_at == null ? `<a href="/keys/${key.id}/revoke">Revoke</a>` : '—'}</td></tr>`).join('');
  return shell({
    title: 'API keys', active: '/keys', identity,
    content: `<header class="page-header"><div><p class="eyebrow">Credentials</p><h1>API keys</h1><p>Create and revoke credentials for the PageSpatial API.</p></div></header><section class="split-layout"><form class="panel key-form" method="post" action="/keys"><h2>Create key</h2><label>Name<input name="name" maxlength="64" autocomplete="off" required placeholder="Production CLI"></label><button type="submit">Create API key</button><p class="small-note">The secret is shown once and is never stored in plaintext.</p></form><section><h2>Your keys</h2>${rows ? `<div class="data-table"><table><caption class="sr-only">API keys</caption><thead><tr><th scope="col">Name</th><th scope="col">Prefix</th><th scope="col">State</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col"><span class="sr-only">Action</span></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty-state"><h3>No API keys</h3><p>Create a key to call the API.</p></div>'}</section></section>`,
  });
}

export function createdKeyPage({ identity, secret }) {
  return shell({
    title: 'API key created', active: '/keys', identity,
    content: `<section class="narrow-page"><p class="eyebrow">One-time secret</p><h1>API key created</h1><div class="notice notice--warning"><strong>Copy this key now.</strong><p>It will not be shown again. If you lose it, revoke it and create another.</p></div><pre class="secret"><code>${escapeHtml(secret)}</code></pre><a class="button button--secondary" href="/keys">Return to API keys</a></section>`,
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
