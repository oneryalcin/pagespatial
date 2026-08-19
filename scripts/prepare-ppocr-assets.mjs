import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'assets', 'ppocrv6-tiny.manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const outputFlag = process.argv.indexOf('--output');
if (outputFlag >= 0 && !process.argv[outputFlag + 1]) throw new Error('--output requires a directory path.');
const output = resolve(outputFlag >= 0 ? process.argv[outputFlag + 1] : join(root, 'public', 'ocr-assets'));
const verifyOnly = process.argv.includes('--verify');
const packageRoots = new Map();

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verify(path, artifact) {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile()) throw new Error(`Missing asset: ${path}`);
  if (metadata.size !== artifact.bytes) throw new Error(`${artifact.path} has ${metadata.size} bytes; expected ${artifact.bytes}.`);
  const actual = await digest(path);
  if (actual !== artifact.sha256) throw new Error(`${artifact.path} has SHA-256 ${actual}; expected ${artifact.sha256}.`);
}

function tarEntries(bytes) {
  const entries = [];
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (bytes.subarray(offset).some((byte) => byte !== 0)) throw new Error('Tar contains non-zero trailing data.');
      break;
    }
    const field = (start, length) => Buffer.from(header.subarray(start, start + length)).toString('utf8').replace(/\0.*$/s, '');
    const prefix = field(345, 155);
    const name = `${prefix}${prefix ? '/' : ''}${field(0, 100)}`;
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    if (!name || !Number.isFinite(size)) throw new Error('Invalid tar header.');
    entries.push({ name, size });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function verifyModel(path, artifact) {
  const entries = tarEntries(await readFile(path));
  const required = [`${artifact.directory}/`, `${artifact.directory}/inference.onnx`, `${artifact.directory}/inference.yml`];
  if (entries.length !== required.length || required.some((name) => !entries.some((entry) => entry.name === name))) {
    throw new Error(`${artifact.path} has an unexpected archive layout.`);
  }
  for (const suffix of ['inference.onnx', 'inference.yml']) {
    if (!entries.some((entry) => entry.name.endsWith(suffix) && entry.size > 0)) throw new Error(`${artifact.path} has an empty ${suffix}.`);
  }
}

async function verifyPackages() {
  for (const [name, version] of Object.entries(manifest.packages)) {
    let directory = dirname(fileURLToPath(import.meta.resolve(name)));
    let metadata;
    while (directory !== dirname(directory)) {
      const candidate = join(directory, 'package.json');
      metadata = await readFile(candidate, 'utf8').then(JSON.parse).catch(() => undefined);
      if (metadata?.name === name) break;
      directory = dirname(directory);
    }
    if (metadata?.name !== name) throw new Error(`Could not resolve installed package ${name}.`);
    if (metadata.version !== version) throw new Error(`${name} must be exactly ${version}; found ${metadata.version ?? 'unknown'}.`);
    packageRoots.set(name, directory);
  }
}

async function acquire(artifact) {
  const target = join(output, artifact.path);
  await mkdir(dirname(target), { recursive: true });
  const existing = await stat(target).catch(() => null);
  if (existing) {
    await verify(target, artifact);
    if (artifact.kind === 'model') await verifyModel(target, artifact);
    return;
  }
  if (verifyOnly) throw new Error(`Missing asset: ${target}`);
  const temporary = `${target}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  try {
    if (artifact.kind === 'runtime') {
      const runtimePrefix = 'node_modules/onnxruntime-web/';
      if (!artifact.source.startsWith(runtimePrefix)) throw new Error(`Unsupported runtime source: ${artifact.source}`);
      const source = join(packageRoots.get('onnxruntime-web'), artifact.source.slice(runtimePrefix.length));
      await verify(source, artifact);
      await copyFile(source, temporary);
    } else {
      const response = await fetch(artifact.source, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`Download failed for ${artifact.path}: HTTP ${response.status}.`);
      await writeFile(temporary, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
    }
    await verify(temporary, artifact);
    if (artifact.kind === 'model') await verifyModel(temporary, artifact);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

await verifyPackages();
for (const artifact of manifest.artifacts) await acquire(artifact);
if (!verifyOnly) await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
for (const artifact of manifest.artifacts) {
  const target = join(output, artifact.path);
  await verify(target, artifact);
  if (artifact.kind === 'model') await verifyModel(target, artifact);
}
console.log(`${verifyOnly ? 'Verified' : 'Prepared'} ${manifest.artifacts.length} PP-OCR assets under ${output}.`);
