export class AppError extends Error {
  constructor(message, status = 400, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const fail = (condition, message, status = 400) => { if (condition) throw new AppError(message, status); };
