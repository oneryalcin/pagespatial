import { Buffer } from 'node:buffer';
import {
  COMPACT_PAGE_SCHEMA_VERSION,
  pageSpatialSchema,
  projectCompactPage,
} from '../../dist/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const EXECUTION_ID = /^[0-9a-f]{32}$/u;

function requireMatch(name, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function projectPages(pages, inputSha256) {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 200) {
    throw new TypeError('pages must contain 1..200 entries');
  }
  return pages.map((entry, index) => {
    const pageNumber = index + 1;
    if (!entry || typeof entry !== 'object' || entry.pageNumber !== pageNumber) {
      throw new TypeError('pages must be ordered and contiguous');
    }
    if (entry.ok === true) {
      const pageSpatial = pageSpatialSchema.parse(entry.pageSpatial);
      if (pageSpatial.pageNumber !== pageNumber || pageSpatial.documentSha256 !== inputSha256) {
        throw new TypeError('page identity does not match the publication');
      }
      return {
        evidence: { page_number: pageNumber, ok: true, page_spatial: pageSpatial },
        compact: {
          page_number: pageNumber,
          ok: true,
          page_compact: projectCompactPage(pageSpatial),
        },
      };
    }
    if (entry.ok === false) {
      const failure = {
        code: 'page_failed',
        message: 'Page could not be parsed.',
      };
      return {
        evidence: { page_number: pageNumber, ok: false, failure },
        compact: { page_number: pageNumber, ok: false, failure },
      };
    }
    throw new TypeError('page has no boolean outcome');
  });
}

/** Build the two closed public representations in Node. */
export function buildPublicResultArtifacts(input) {
  const jobId = requireMatch('jobId', input.jobId, UUID);
  const attemptId = requireMatch('attemptId', input.attemptId, UUID);
  const executionId = requireMatch('executionId', input.executionId, EXECUTION_ID);
  const inputSha256 = requireMatch('inputSha256', input.inputSha256, SHA256);
  const pages = projectPages(input.pages, inputSha256);
  const common = {
    job_id: jobId,
    attempt_id: attemptId,
    input_sha256: inputSha256,
    page_count: pages.length,
  };
  const evidence = {
    schema_version: 1,
    job_id: common.job_id,
    attempt_id: common.attempt_id,
    execution_id: executionId,
    input_sha256: common.input_sha256,
    page_count: common.page_count,
    pages: pages.map((page) => page.evidence),
  };
  const compact = {
    schema_version: COMPACT_PAGE_SCHEMA_VERSION,
    representation: 'compact',
    ...common,
    pages: pages.map((page) => page.compact),
  };
  return {
    pageCount: pages.length,
    evidenceBytes: Buffer.from(JSON.stringify(evidence)),
    compactBytes: Buffer.from(JSON.stringify(compact)),
  };
}
