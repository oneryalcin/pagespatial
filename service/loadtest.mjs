/**
 * Load driver: submit PDFs to a running parse-service, poll to completion,
 * print the bottleneck table the service exists to produce.
 *
 * Usage:
 *   node service/loadtest.mjs --base http://localhost:8571 <pdf> [<pdf>...]
 */
const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const base = baseIndex >= 0 ? args[baseIndex + 1] : 'http://localhost:8571';
const pdfs = args.filter((value, index) => index !== baseIndex && index !== baseIndex + 1);
if (!pdfs.length) {
  console.error('Usage: node service/loadtest.mjs [--base URL] <pdf> [<pdf>...]');
  process.exit(1);
}

const startedMs = Date.now();
const jobs = [];
for (const pdfPath of pdfs) {
  const response = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pdfPath })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${pdfPath}: ${body.error}`);
  console.log(`submitted ${pdfPath} -> ${body.jobId} (${body.pageCount} pages)`);
  jobs.push(body.jobId);
}

let lastProgress = '';
for (;;) {
  const statuses = await Promise.all(jobs.map(async (jobId) => (await fetch(`${base}/v1/jobs/${jobId}`)).json()));
  const done = statuses.filter((status) => status.status === 'completed').length;
  const pages = statuses.reduce((sum, status) => sum + status.completedPages, 0);
  const total = statuses.reduce((sum, status) => sum + status.pageCount, 0);
  const progress = `${pages}/${total} pages, ${done}/${jobs.length} jobs`;
  if (progress !== lastProgress) { console.log(progress); lastProgress = progress; }
  if (done === jobs.length) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const wallSec = (Date.now() - startedMs) / 1000;
const metrics = await (await fetch(`${base}/v1/metrics`)).json();
console.log(`\nend-to-end wall: ${wallSec.toFixed(1)}s  service-measured pages/sec: ${metrics.pagesPerSecond}`);
console.log(`worker rss peak: ${(metrics.workerRssPeakBytes / 1024 / 1024).toFixed(0)} MB\n`);
console.log('stage        p50 ms   p95 ms   max ms   mean ms');
for (const [stage, stat] of Object.entries(metrics.stageMs)) {
  console.log(`${stage.padEnd(12)} ${String(stat.p50).padStart(6)} ${String(stat.p95).padStart(8)} ${String(stat.max).padStart(8)} ${String(stat.mean).padStart(9)}`);
}
const wall = metrics.pageWallMs;
console.log(`${'page wall'.padEnd(12)} ${String(wall.p50).padStart(6)} ${String(wall.p95).padStart(8)} ${String(wall.max).padStart(8)} ${String(wall.mean).padStart(9)}`);
