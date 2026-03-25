export type ErrorCode =
  // Client errors
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'PLAYER_NOT_FOUND'
  | 'PROFILE_NOT_FOUND'
  | 'RESOURCE_NOT_FOUND'
  | 'RATE_LIMITED'
  // Server errors
  | 'HYPIXEL_API_ERROR'
  | 'HYPIXEL_RATE_LIMITED'
  | 'HYPIXEL_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ResponseMeta {
  cached: boolean;
  cache_age_seconds: number | null;
  timestamp: number;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta: ResponseMeta;
}

export interface ApiError {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    status: number;
  };
  meta: {
    timestamp: number;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;
