import {
  HeadObjectCommand, PutObjectCommand, GetObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sendWithDeadline } from './deadline.mjs';

const contentType = 'application/pdf';

export class ObjectStoreUnavailableError extends Error {}

function secondsUntil(expiresAt, now = new Date()) {
  const seconds = Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw new TypeError('presigned URL expiry is past');
  return Math.min(seconds, 3600);
}

const missing = (error) => error?.name === 'NotFound'
  || error?.name === 'NoSuchKey'
  || error?.$metadata?.httpStatusCode === 404;

export function createInputObjectStore({
  client, bucket, sign = getSignedUrl, operationTimeoutMs = 10_000,
}) {
  if (!client?.send || typeof bucket !== 'string' || !bucket) {
    throw new TypeError('input object store requires an S3 client and bucket');
  }
  const key = (jobId) => `inputs/${jobId}.pdf`;
  return {
    bucket,
    key,
    async createUploadGrant({ jobId, expiresAt, now = new Date() }) {
      const command = new PutObjectCommand({
        Bucket: bucket, Key: key(jobId), ContentType: contentType,
      });
      const expiresIn = secondsUntil(expiresAt, now);
      return {
        method: 'PUT',
        url: await sign(client, command, { expiresIn }),
        expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
        headers: { 'content-type': contentType },
      };
    },
    async head({ jobId }) {
      try {
        const value = await sendWithDeadline(
          client, new HeadObjectCommand({ Bucket: bucket, Key: key(jobId) }),
          operationTimeoutMs, 'R2 input head',
        );
        return {
          bytes: value.ContentLength,
          contentType: value.ContentType,
          lastModified: value.LastModified,
        };
      } catch (error) {
        if (missing(error)) return null;
        throw new ObjectStoreUnavailableError('input object could not be inspected', { cause: error });
      }
    },
  };
}

export function createResultDownloadStore({ client, bucket, sign = getSignedUrl }) {
  if (!client?.send || typeof bucket !== 'string' || !bucket) {
    throw new TypeError('result download store requires an S3 client and bucket');
  }
  return {
    bucket,
    async createDownloadGrant({ key, expiresAt, now = new Date() }) {
      const expiresIn = Math.min(secondsUntil(expiresAt, now), 5 * 60);
      return {
        schema_version: 1,
        download_url: await sign(
          client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn },
        ),
        expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
        content_type: 'application/json',
      };
    },
  };
}

export function s3ClientFromConfig({ endpoint, accessKeyId, secretAccessKey }) {
  for (const [name, value] of Object.entries({ endpoint, accessKeyId, secretAccessKey })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
  }
  if (!endpoint.startsWith('https://')) throw new TypeError('R2 endpoint must use https');
  return new S3Client({
    endpoint: endpoint.replace(/\/$/u, ''),
    region: 'auto',
    credentials: { accessKeyId, secretAccessKey },
  });
}
