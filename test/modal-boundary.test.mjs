/**
 * Source-boundary invariants for the Modal adapter (design doc
 * 2026-08-23-modal-scaling-and-deployment.md §6, §17): Modal is a
 * deployment dependency confined to deploy/modal/, never a runtime
 * dependency of the parser or the service. Config invariants are asserted
 * textually against the adapter file — cheap, and they fail loudly if a
 * refactor drops a required bound.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

test('zero Modal imports in src/ and service/', () => {
  const offenders = [];
  for (const base of ['src', 'service']) {
    for (const path of walk(join(root, base))) {
      const text = readFileSync(path, 'utf8');
      if (/^\s*(import\s+modal\b|from\s+modal\b)/m.test(text)) offenders.push(path);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the Modal adapter is confined to deploy/modal/', () => {
  const deployDir = join(root, 'deploy');
  assert.ok(existsSync(join(deployDir, 'modal', 'modal_app.py')), 'deploy/modal/modal_app.py exists');
  const strays = readdirSync(deployDir).filter((name) => name !== 'modal');
  assert.deepEqual(strays, [], 'deploy/ contains only the modal adapter');
});

test('adapter config invariants (§7): parse-only, loopback, bounded', () => {
  const adapter = readFileSync(join(root, 'deploy', 'modal', 'modal_app.py'), 'utf8');
  // Enrichment forced off — rejected on input AND explicit on the loopback POST.
  assert.match(adapter, /enrichment must be "off"/);
  assert.match(adapter, /\/v1\/jobs\?enrichment=off/);
  // No enrichment credentials, no pdfPath mode, loopback-only Node.
  assert.match(adapter, /env\.pop\("GEMINI_API_KEY"/);
  assert.match(adapter, /env\.pop\("SERVICE_ALLOW_PDF_PATH"/);
  assert.match(adapter, /"HOST": "127\.0\.0\.1"/);
  // Server-side pdfPath is never accepted as an input.
  assert.match(adapter, /"pdfPath" in payload/);
  // Bounds: page cap wired to the service, containers capped in code.
  assert.match(adapter, /"SERVICE_MAX_PAGES_PER_JOB": str\(MAX_PAGES_PER_JOB\)/);
  assert.match(adapter, /MAX_PAGES_PER_JOB = 200\b/);
  assert.match(adapter, /max_containers=\d+/);
  assert.match(adapter, /min_containers=0/);
  assert.match(adapter, /buffer_containers=0/);
  // Warm-lifetime job budget present.
  assert.match(adapter, /MAX_NODE_JOBS_PER_LIFETIME = 100\b/);
  // The experimental stop-fetching API has exactly ONE call site (§7.3).
  const callSites = adapter.match(/modal\.experimental\.stop_fetching_inputs\(\)/g) ?? [];
  assert.equal(callSites.length, 1);
});

test('test-only failure injection cannot reach the production deployment (§14.2)', () => {
  const adapter = readFileSync(join(root, 'deploy', 'modal', 'modal_app.py'), 'utf8');
  // Double gate: the runtime check requires BOTH the explicit env flag AND
  // a dev/test app name; either missing is a visible InputRejected.
  assert.match(adapter, /def injection_allowed[\s\S]*?PAGESPATIAL_ENABLE_TEST_FAILURES.*== "1"[\s\S]*?_is_dev_app/);
  assert.match(adapter, /raise InputRejected\("test_failure is not available on this deployment"\)/);
  // The env flag is baked into the image ONLY under modal.is_local() when
  // an operator sets it at deploy time, and deploying it to a non-dev app
  // name refuses outright — the flag has no default anywhere.
  const bakes = adapter.match(/_baked_env\["PAGESPATIAL_ENABLE_TEST_FAILURES"\] = "1"/g) ?? [];
  assert.equal(bakes.length, 1, 'exactly one conditional bake site');
  assert.match(adapter, /if _enable_test_failures and not _is_dev_app\(APP_NAME\):\s*\n\s*raise RuntimeError/);
  assert.doesNotMatch(adapter, /PAGESPATIAL_ENABLE_TEST_FAILURES.*=.*"1".*#.*default/);
  // Injection modes are a closed set with NO container self-kill: §14.2
  // requires container failure to be injected externally and one-shot (a
  // self-kill input would be rescheduled and could crash-loop).
  assert.match(adapter, /INJECTION_MODES = \("exception", "timeout", "kill-node"\)/);
  assert.doesNotMatch(adapter, /"kill-container"|os\.kill\(\s*1\b|sys\.exit\(.*\)\s*#.*inject/);
  // Lifecycle probes sit behind the same gate.
  const probeGates = adapter.match(/self\._require_dev_instrument\("probe_/g) ?? [];
  assert.equal(probeGates.length, 2, 'both probes are dev-gated');
});
