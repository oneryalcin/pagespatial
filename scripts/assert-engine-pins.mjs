/**
 * Build-time engine-pin assertion (workstream 1, M1).
 *
 * The weight pins live in service/sidecar/model-pins.json; the ENGINE pins
 * (paddleocr / paddlepaddle versions) live in DEFAULT_PYTHON_CMD
 * (service/adapters/ppocr-sidecar.mjs) and are what `meta.versions.*`
 * reports at runtime. The Dockerfile pip-installs its own pins — without
 * this assertion the "ceremony-validated" guarantee would cover the weights
 * but not the engine that loads them. The image build FAILS on any drift.
 *
 * Usage: node scripts/assert-engine-pins.mjs paddleocr==3.7.0 paddlepaddle==3.2.1
 * Every `--with pkg==version` pin in DEFAULT_PYTHON_CMD must be supplied and
 * must match exactly; extra or missing arguments fail.
 */
import { DEFAULT_PYTHON_CMD } from '../service/adapters/ppocr-sidecar.mjs';

const expected = new Map();
for (let index = 0; index < DEFAULT_PYTHON_CMD.length; index += 1) {
  if (DEFAULT_PYTHON_CMD[index] !== '--with') continue;
  const spec = DEFAULT_PYTHON_CMD[index + 1] ?? '';
  const [pkg, version] = spec.split('==');
  if (!pkg || !version) {
    console.error(`assert-engine-pins: unparseable pin '${spec}' in DEFAULT_PYTHON_CMD.`);
    process.exit(1);
  }
  expected.set(pkg, version);
}

const supplied = new Map();
for (const argument of process.argv.slice(2)) {
  const [pkg, version] = argument.split('==');
  if (!pkg || !version) {
    console.error(`assert-engine-pins: argument '${argument}' is not pkg==version.`);
    process.exit(1);
  }
  supplied.set(pkg, version);
}

const failures = [];
for (const [pkg, version] of expected) {
  const got = supplied.get(pkg);
  if (got === undefined) failures.push(`${pkg}: pinned ${version} in DEFAULT_PYTHON_CMD but not supplied to the build`);
  else if (got !== version) failures.push(`${pkg}: DEFAULT_PYTHON_CMD pins ${version}, build supplies ${got}`);
}
for (const [pkg, version] of supplied) {
  if (!expected.has(pkg)) failures.push(`${pkg}==${version}: supplied to the build but absent from DEFAULT_PYTHON_CMD`);
}

if (failures.length) {
  console.error(`assert-engine-pins: ENGINE PIN MISMATCH — refusing the build:\n${failures.map((line) => `  ${line}`).join('\n')}`);
  process.exit(1);
}
console.log(`assert-engine-pins: ${[...expected].map(([pkg, version]) => `${pkg}==${version}`).join(', ')} match DEFAULT_PYTHON_CMD.`);
