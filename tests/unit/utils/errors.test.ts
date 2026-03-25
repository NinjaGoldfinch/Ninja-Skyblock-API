import { describe, it, expect } from 'vitest';
import { AppError, errors } from '../../../src/utils/errors.js';

describe('AppError', () => {
  it('creates error with code, status, and message', () => {
    const err = new AppError('PLAYER_NOT_FOUND', 404, 'Not found');
    expect(err.code).toBe('PLAYER_NOT_FOUND');
    expect(err.status).toBe(404);
    expect(err.message).toBe('Not found');
    expect(err.name).toBe('AppError');
    expect(err).toBeInstanceOf(Error);
  });

  it('stores cause when provided', () => {
    const cause = new Error('original');
    const err = new AppError('INTERNAL_ERROR', 500, 'Wrapped', cause);
    expect(err.cause).toBe(cause);
  });
});

describe('error factories', () => {
  it('playerNotFound includes UUID in message', () => {
    const err = errors.playerNotFound('abc123');
    expect(err.code).toBe('PLAYER_NOT_FOUND');
    expect(err.status).toBe(404);
    expect(err.message).toContain('abc123');
  });

  it('rateLimited returns 429', () => {
    const err = errors.rateLimited();
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.status).toBe(429);
  });

  it('unauthorized returns 401', () => {
    const err = errors.unauthorized();
    expect(err.status).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('hypixelDown returns 503', () => {
    const err = errors.hypixelDown();
    expect(err.code).toBe('HYPIXEL_UNAVAILABLE');
    expect(err.status).toBe(503);
  });

  it('hypixelRateLimited returns 503', () => {
    const err = errors.hypixelRateLimited();
    expect(err.code).toBe('HYPIXEL_RATE_LIMITED');
    expect(err.status).toBe(503);
  });

  it('validation returns 400 with custom message', () => {
    const err = errors.validation('bad uuid');
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.status).toBe(400);
    expect(err.message).toBe('bad uuid');
  });
});
