export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const notFound = (msg = 'Not found') => new ApiError(404, 'NOT_FOUND', msg);
export const bad = (code, msg) => new ApiError(400, code, msg);
