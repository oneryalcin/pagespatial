const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/u;

const token = (value) => typeof value === 'string' && SAFE_TOKEN.test(value)
  ? value : undefined;

export function logFailure(log, event, {
  requestId, reason, method, operation, error,
} = {}) {
  const record = { event: token(event) ?? 'log_failure' };
  const safeRequestId = token(requestId);
  const safeReason = token(reason);
  const safeMethod = token(method);
  const safeOperation = token(operation);
  if (safeRequestId) record.request_id = safeRequestId;
  if (safeReason) record.reason = safeReason;
  if (safeMethod) record.method = safeMethod;
  if (safeOperation) record.operation = safeOperation;
  try {
    const detail = error?.cause ?? error;
    const errorName = token(detail?.constructor?.name);
    const errorCode = token(detail?.code);
    if (errorName) record.error_name = errorName;
    if (errorCode) record.error_code = errorCode;
  } catch {
    // Logging must not replace the failure being handled.
  }
  try {
    log?.error?.(record, event);
  } catch {
    // A broken logger must not change request or shutdown behavior.
  }
}
