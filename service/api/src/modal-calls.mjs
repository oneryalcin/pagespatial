import {
  FunctionTimeoutError, ModalClient, RemoteError,
} from 'modal';

/**
 * @typedef (
 *   {kind: 'pending'} |
 *   {kind: 'completed', output: unknown} |
 *   {kind: 'failed', error: string} |
 *   {kind: 'unavailable', error: string}
 * ) CallOutcome
 */

const message = (error) => `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`;

/** Modal is the queue. This adapter exposes only the two operations M1 uses. */
export function createModalCalls({
  client = new ModalClient(), appName, clsName = 'ParseContainer', methodName = 'parse_object',
}) {
  if (typeof appName !== 'string' || !appName) throw new TypeError('Modal appName is required');
  let methodPromise;
  const method = () => {
    if (!methodPromise) {
      const lookup = client.cls.fromName(appName, clsName)
        .then((cls) => cls.instance({}))
        .then((instance) => instance.method(methodName));
      const cached = lookup.catch((error) => {
        // Cache a usable handle, never a transient control-plane failure.
        if (methodPromise === cached) methodPromise = undefined;
        throw error;
      });
      methodPromise = cached;
    }
    return methodPromise;
  };
  return {
    async spawn(payload) {
      const call = await (await method()).spawn([payload]);
      if (typeof call?.functionCallId !== 'string' || !call.functionCallId) {
        throw new TypeError('Modal spawn returned no functionCallId');
      }
      return { callId: call.functionCallId };
    },
    /** @returns {Promise<CallOutcome>} */
    async inspect(callId) {
      try {
        const call = await client.functionCalls.fromId(callId);
        return { kind: 'completed', output: await call.get({ timeoutMs: 0 }) };
      } catch (error) {
        if (error instanceof FunctionTimeoutError) return { kind: 'pending' };
        if (error instanceof RemoteError) return { kind: 'failed', error: message(error) };
        return { kind: 'unavailable', error: message(error) };
      }
    },
  };
}
