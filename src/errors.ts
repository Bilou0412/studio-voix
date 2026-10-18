// Erreurs structurées de la spec : {code, message, retryable, hint}, codes stables.
export type ErrorCode =
  | "voice_not_ready"
  | "voice_not_found"
  | "consent_missing"
  | "quota_exceeded"
  | "gpu_unavailable"
  | "text_too_long"
  | "qa_failed"
  | "not_found"
  | "invalid_input"
  | "forbidden"
  | "upload_incomplete"
  | "checksum_mismatch"
  | "reference_invalid"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  voice_not_ready: 409,
  voice_not_found: 404,
  consent_missing: 422,
  quota_exceeded: 429,
  gpu_unavailable: 503,
  text_too_long: 422,
  qa_failed: 422,
  not_found: 404,
  invalid_input: 400,
  forbidden: 403,
  upload_incomplete: 409,
  checksum_mismatch: 422,
  reference_invalid: 422,
  internal: 500,
};

const RETRYABLE = new Set<ErrorCode>(["gpu_unavailable", "quota_exceeded", "upload_incomplete", "internal"]);

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
  get status() {
    return STATUS[this.code];
  }
  get retryable() {
    return RETRYABLE.has(this.code);
  }
  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, hint: this.hint ?? null };
  }
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ApiError("internal", message);
}
