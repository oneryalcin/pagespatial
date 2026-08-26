export class DeadlineExceededError extends Error {}

export function withDeadline(promise, timeoutMs, label) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive integer');
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new DeadlineExceededError(`${label} exceeded ${timeoutMs} ms`)), timeoutMs,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function withAbortableDeadline(operation, timeoutMs, label) {
  const controller = new AbortController();
  try {
    return await withDeadline(
      Promise.resolve().then(() => operation(controller.signal)), timeoutMs, label,
    );
  } catch (error) {
    if (error instanceof DeadlineExceededError) controller.abort(error);
    throw error;
  }
}

export function sendWithDeadline(client, command, timeoutMs, label) {
  return withAbortableDeadline(
    (abortSignal) => client.send(command, { abortSignal }), timeoutMs, label,
  );
}
