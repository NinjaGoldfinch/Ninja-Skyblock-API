import type { ErrorCode } from '../types/api.js';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  playerNotFound: (uuid: string) =>
    new AppError('PLAYER_NOT_FOUND', 404, `No SkyBlock profile found for player ${uuid}`),
  profileNotFound: (uuid: string) =>
    new AppError('PROFILE_NOT_FOUND', 404, `No SkyBlock profile found for player ${uuid}`),
  rateLimited: () =>
    new AppError('RATE_LIMITED', 429, 'Rate limit exceeded. Try again shortly.'),
  unauthorized: (message = 'Missing or invalid authentication.') =>
    new AppError('UNAUTHORIZED', 401, message),
  forbidden: (message = 'Insufficient permissions.') =>
    new AppError('FORBIDDEN', 403, message),
  validation: (message: string) =>
    new AppError('VALIDATION_ERROR', 400, message),
  hypixelError: (cause: unknown) =>
    new AppError('HYPIXEL_API_ERROR', 502, 'Hypixel API returned an error.', cause),
  hypixelRateLimited: () =>
    new AppError('HYPIXEL_RATE_LIMITED', 503, 'Hypixel API key is rate limited. Retry later.'),
  hypixelDown: () =>
    new AppError('HYPIXEL_UNAVAILABLE', 503, 'Hypixel API is currently unavailable. Retry later.'),
  internal: (cause?: unknown) =>
    new AppError('INTERNAL_ERROR', 500, 'An unexpected error occurred.', cause),
} as const;
