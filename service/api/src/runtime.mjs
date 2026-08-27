import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { createAccessAuthenticator } from './access-auth.mjs';
import { createApiHandler } from './http.mjs';
import { withDeadline, DeadlineExceededError } from './deadline.mjs';
import { dispatchQueuedOnce } from './queued-dispatcher.mjs';
import { migrate } from './migrate.mjs';
import { createModalCalls } from './modal-calls.mjs';
import {
  createInputObjectStore, createResultDownloadStore, s3ClientFromConfig,
} from './object-stores.mjs';
import { createR2ResultStore } from './r2-results.mjs';
import { reconcileOnce } from './reconciler.mjs';
import { logFailure } from './safe-log.mjs';

const PASS_TIMEOUT_MS = 45_000;

const required = (env, name) => {
  const value = env[name];
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
  return value;
};

export function validateR2Isolation({
  inputBucket, resultsBucket, inputAccessKeyId, resultsAccessKeyId,
}) {
  if (inputBucket === resultsBucket) {
    throw new TypeError('R2 input and results buckets must be distinct');
  }
  if (inputAccessKeyId === resultsAccessKeyId) {
    throw new TypeError('R2 input and results credentials must be distinct');
  }
}

function loop(task, intervalMs, onError) {
  let stopped = false;
  let active = Promise.resolve();
  let timer;
  const run = () => {
    if (stopped) return;
    active = Promise.resolve().then(task).catch(onError).finally(() => {
      if (!stopped) timer = setTimeout(run, intervalMs);
    });
  };
  run();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await withDeadline(active, 60_000, 'background shutdown').catch(() => {});
  };
}
async function reconcilerPass({ pool, modalCalls, resultStore, inputBucket }) {
  const client = await withDeadline(pool.connect(), 2_000, 'Postgres checkout');
  let destroyed = false;
  try {
    return await withDeadline(reconcileOnce({
      db: client,
      modalCalls,
      resultStore,
      inputBucket,
      limit: 8,
    }), PASS_TIMEOUT_MS, 'reconciler pass');
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      client.release(true);
      destroyed = true;
    }
    throw error;
  } finally {
    if (!destroyed) client.release();
  }
}

export async function startRuntime({ env = process.env, log = console } = {}) {
  const inputEndpoint = required(env, 'R2_INPUT_ENDPOINT');
  const inputAccessKeyId = required(env, 'R2_API_INPUT_ACCESS_KEY_ID');
  const inputSecretAccessKey = required(env, 'R2_API_INPUT_SECRET_ACCESS_KEY');
  const resultsEndpoint = required(env, 'R2_RESULTS_ENDPOINT');
  const resultsAccessKeyId = required(env, 'R2_API_RESULTS_ACCESS_KEY_ID');
  const resultsSecretAccessKey = required(env, 'R2_API_RESULTS_SECRET_ACCESS_KEY');
  const inputBucket = required(env, 'R2_INPUT_BUCKET');
  const resultsBucket = required(env, 'R2_RESULTS_BUCKET');
  const apiHost = required(env, 'PAGESPATIAL_API_HOST');
  const appHost = required(env, 'PAGESPATIAL_APP_HOST');
  const accessIssuer = required(env, 'CLOUDFLARE_ACCESS_ISSUER');
  const accessAudience = required(env, 'CLOUDFLARE_ACCESS_AUDIENCE');
  if (apiHost === appHost) throw new TypeError('API and dashboard hosts must be distinct');
  validateR2Isolation({
    inputBucket, resultsBucket, inputAccessKeyId, resultsAccessKeyId,
  });

  const pool = new pg.Pool({
    connectionString: required(env, 'DATABASE_URL'),
    max: Number(env.PAGESPATIAL_DB_POOL_SIZE ?? 10),
    connectionTimeoutMillis: 2_000,
    statement_timeout: 5_000,
  });
  const migrationClient = await pool.connect();
  try {
    await migrate(migrationClient);
  } finally {
    migrationClient.release();
  }

  const inputClient = s3ClientFromConfig({
    endpoint: inputEndpoint,
    accessKeyId: inputAccessKeyId,
    secretAccessKey: inputSecretAccessKey,
  });
  const resultClient = s3ClientFromConfig({
    endpoint: resultsEndpoint,
    accessKeyId: resultsAccessKeyId,
    secretAccessKey: resultsSecretAccessKey,
  });
  const inputStore = createInputObjectStore({
    client: inputClient,
    bucket: inputBucket,
    uploadOrigin: new URL(inputEndpoint).origin,
  });
  const resultStore = createR2ResultStore({ client: resultClient, bucket: resultsBucket });
  const resultDownloads = createResultDownloadStore({
    client: resultClient, bucket: resultsBucket,
  });
  const modalCalls = createModalCalls({
    appName: required(env, 'PAGESPATIAL_MODAL_APP_NAME'),
  });
  const authenticateAccess = createAccessAuthenticator({
    db: pool, issuer: accessIssuer, audience: accessAudience,
  });
  const createRequestId = randomUUID;
  const handler = createApiHandler({
    db: pool,
    pool,
    inputStore,
    resultStore: resultDownloads,
    inputBucket,
    apiHost,
    appHost,
    appOrigin: `https://${appHost}`,
    authenticateAccess,
    createRequestId,
    log,
    unitPriceMicros: Number(env.PAGESPATIAL_UNIT_PRICE_MICROS ?? 1000),
    healthDependencies: {
      r2_input: () => inputStore.probe(),
      r2_results: () => resultStore.probe(),
      modal: () => modalCalls.probe(),
    },
  });
  const server = createServer((req, res) => {
    const requestId = createRequestId();
    handler(req, res, requestId).catch((error) => {
      logFailure(log, 'http_handler_unhandled', {
        requestId, method: req.method, operation: 'http_handler', error,
      });
      res.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(
      Number(env.PORT ?? 8580), env.HOST ?? '127.0.0.1', resolve,
    );
  });

  const report = (name) => (error) => logFailure(log, 'background_pass_failed', {
    reason: name, error,
  });
  const stopDispatch = loop(
    () => withDeadline(dispatchQueuedOnce({
      db: pool, modalCalls, inputBucket, limit: 8,
    }), PASS_TIMEOUT_MS, 'queued dispatch pass'),
    5_000,
    report('queued_dispatch'),
  );
  const stopReconciler = loop(
    () => reconcilerPass({ pool, modalCalls, resultStore, inputBucket }),
    60_000,
    report('reconciler'),
  );

  return {
    server,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await Promise.all([stopDispatch(), stopReconciler()]);
      await pool.end();
    },
  };
}
