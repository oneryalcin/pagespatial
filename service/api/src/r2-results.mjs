import {
  GetObjectCommand, ListObjectsV2Command, S3Client,
} from '@aws-sdk/client-s3';
import { RESULT_LIMIT_BYTES } from './result-contract.mjs';

const MAX_ATTEMPT_OBJECTS = 16;

async function readBounded(body, declaredLength) {
  if (Number.isFinite(declaredLength) && declaredLength > RESULT_LIMIT_BYTES) {
    throw new RangeError('R2 result exceeds the publication bound');
  }
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('R2 GetObject returned no readable body');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > RESULT_LIMIT_BYTES) throw new RangeError('R2 result exceeds the publication bound');
    chunks.push(bytes);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

/** A narrow R2 reader. It has no write method by design. */
export function createR2ResultStore({ client, bucket }) {
  if (!client || typeof client.send !== 'function') throw new TypeError('R2 client must provide send()');
  if (typeof bucket !== 'string' || !bucket) throw new TypeError('R2 results bucket is required');
  return {
    bucket,
    async listAttemptResults({ jobId, attemptId }) {
      const prefix = `results/${jobId}/${attemptId}/`;
      const found = [];
      let continuationToken;
      do {
        const response = await client.send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken,
          MaxKeys: MAX_ATTEMPT_OBJECTS + 1,
        }));
        for (const item of response.Contents ?? []) {
          if (typeof item.Key === 'string') found.push({ key: item.Key, lastModified: item.LastModified });
          if (found.length > MAX_ATTEMPT_OBJECTS) {
            throw new RangeError('attempt result prefix contains too many objects');
          }
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
      return found.sort((a, b) => a.key.localeCompare(b.key));
    },
    async readResult({ key }) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return {
        bytes: await readBounded(response.Body, response.ContentLength),
        lastModified: response.LastModified,
      };
    },
  };
}

export function r2ClientFromConfig({ endpoint, accessKeyId, secretAccessKey }) {
  for (const [name, value] of Object.entries({ endpoint, accessKeyId, secretAccessKey })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
  }
  if (!endpoint.startsWith('https://')) throw new TypeError('R2 endpoint must use https');
  return new S3Client({
    endpoint: endpoint.replace(/\/$/, ''), region: 'auto',
    credentials: { accessKeyId, secretAccessKey },
  });
}
