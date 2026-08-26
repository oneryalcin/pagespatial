export class ApiError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, options);
    this.status = status;
    this.code = code;
    this.headers = options.headers ?? {};
  }
}

export const invalidRequest = (message) => new ApiError(400, 'invalid_request', message);
