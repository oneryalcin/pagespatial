import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function stableFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export async function workspaceIdentity(root) {
  const cwd = resolve(root);
  const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  const tracked = (await exec('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout
    .split('\0')
    .filter((path) => path && path !== '.evaluation' && !path.startsWith('.evaluation/'))
    .sort();
  const entries = [];
  for (const path of tracked) {
    const bytes = await readFile(resolve(cwd, path));
    entries.push([path, createHash('sha256').update(bytes).digest('hex')]);
  }
  const clean = (await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd })).stdout
    .split('\n')
    .filter((line) => line && !line.slice(3).startsWith('.evaluation/'))
    .length === 0;
  return { commit, dirty: !clean, workspaceHash: stableFingerprint(entries), files: entries.length };
}
