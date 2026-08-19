import { readFile } from 'node:fs/promises';
import { pageSpatialSchema } from '../../../dist/schema.js';
import { sha256File } from './atomic-json.mjs';

export function safeObjectId(objectId) {
  return objectId.replace(/[^A-Za-z0-9._-]+/gu, '_');
}

export async function resumablePage(envelopePath, expectedFingerprint, expected) {
  try {
    if (typeof expected.outputSha256 !== 'string') return null;
    const outputSha256 = await sha256File(envelopePath);
    if (outputSha256 !== expected.outputSha256) return null;
    const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
    if (envelope.status !== 'succeeded' || envelope.fingerprint !== expectedFingerprint) return null;
    if (envelope.backend?.actual !== expected.actualBackend) return null;
    if (envelope.source?.sha256 !== expected.sha256 || envelope.pageNumber !== expected.pageNumber || envelope.objectId !== expected.objectId) return null;
    pageSpatialSchema.parse(envelope.pageSpatial);
    return { envelope, outputSha256 };
  } catch {
    return null;
  }
}

export function sanitizedFailure(error, stage, partialEvidence = false) {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\b(?:hf_|sk-)[A-Za-z0-9_-]+\b/gu, '[redacted]')
    .replace(/([?&](?:token|key|signature|credential)=)[^&\s]+/giu, '$1[redacted]')
    .replace(/\b(?:HF_TOKEN|OPENROUTER_API_KEY)\s*[=:]\s*\S+/giu, '[redacted]')
    .slice(0, 8_192);
  return {
    stage,
    errorClass: error instanceof Error ? error.name : 'Error',
    message,
    partialEvidence
  };
}
