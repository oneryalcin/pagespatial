import {
  GetObjectCommand, ListObjectsV2Command, S3Client,
} from '@aws-sdk/client-s3';
import { InvalidResultError, RESULT_LIMIT_BYTES } from './result-contract.mjs';
import {
  DeadlineExceededError, sendWithDeadline, withAbortableDeadline,
} from './deadline.mjs';

const MAX_ATTEMPT_OBJECTS = 16;

export class ResultStoreUnavailableError extends Error {}

async function readBounded(body, declaredLength) {
  if (Number.isFinite(declaredLength) && declaredLength > RESULT_LIMIT_BYTES) {
    throw new InvalidResultError('R2 result exceeds the publication bound');
  }
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    throw new ResultStoreUnavailableError('R2 GetObject returned no readable body');
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > RESULT_LIMIT_BYTES) {
        throw new InvalidResultError('R2 result exceeds the publication bound');
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof InvalidResultError) throw error;
    throw new ResultStoreUnavailableError('R2 result body could not be read', { cause: error });
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

/** A narrow R2 reader. It has no write method by design. */
export function createR2ResultStore({ client, bucket, operationTimeoutMs = 10_000 }) {
  if (!client || typeof client.send !== 'function') throw new TypeError('R2 client must provide send()');
  if (typeof bucket !== 'string' || !bucket) throw new TypeError('R2 results bucket is required');
  return {
    bucket,
    async listAttemptResults({ jobId, attemptId }) {
      const prefix = `results/${jobId}/${attemptId}/`;
      const found = [];
      let continuationToken;
      do {
        let response;
        try {
          response = await sendWithDeadline(client, new ListObjectsV2Command({
            Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken,
            MaxKeys: MAX_ATTEMPT_OBJECTS + 1,
          }), operationTimeoutMs, 'R2 result list');
        } catch (error) {
          throw new ResultStoreUnavailableError('R2 result prefix could not be listed', { cause: error });
        }
        for (const item of response.Contents ?? []) {
          if (typeof item.Key === 'string') found.push({ key: item.Key, lastModified: item.LastModified });
          if (found.length > MAX_ATTEMPT_OBJECTS) {
            throw new InvalidResultError('attempt result prefix contains too many objects');
          }
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
      return found.sort((a, b) => a.key.localeCompare(b.key));
    },
    async readResult({ key }) {
      let body;
      try {
        return await withAbortableDeadline(
          async (abortSignal) => {
            const response = await client.send(
              new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal },
            );
            body = response.Body;
            return {
              bytes: await readBounded(body, response.ContentLength),
              lastModified: response.LastModified,
            };
          },
          operationTimeoutMs,
          'R2 result read',
        );
      } catch (error) {
        if (error instanceof InvalidResultError) throw error;
        if (error instanceof DeadlineExceededError) body?.destroy?.(error);
        throw new ResultStoreUnavailableError('R2 result object could not be read', { cause: error });
      }
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
