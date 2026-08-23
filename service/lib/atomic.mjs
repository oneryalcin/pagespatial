/**
 * Atomic state-file writes, shared by the parse queue and the enrichment
 * phase. State files are completion markers: resume paths treat their
 * PRESENCE as truth, so a torn write must never leave a partial file
 * behind. Write-to-temp + rename is atomic on the same filesystem.
 */
import { randomBytes } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';

export function writeFileAtomic(path, contents) {
  const temp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(temp, contents);
  renameSync(temp, path);
}
