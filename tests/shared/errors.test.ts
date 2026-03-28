import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  TriageError,
  PlanningError,
  ExecutionError,
  ReviewError,
  DeploymentError,
} from '../../src/shared/errors';

describe('AppError', () => {
  it('should set message and defaults', () => {
    const err = new AppError('something broke');
    assert.equal(err.message, 'something broke');
    assert.equal(err.code, 'ERR_INTERNAL');
    assert.equal(err.statusCode, 500);
    assert.equal(err.isOperational, true);
    assert.equal(err.name, 'AppError');
  });

  it('should accept custom options', () => {
    const cause = new Error('root cause');
    const err = new AppError('custom', {
      code: 'ERR_CUSTOM',
      statusCode: 503,
      isOperational: false,
      cause,
    });
    assert.equal(err.code, 'ERR_CUSTOM');
    assert.equal(err.statusCode, 503);
    assert.equal(err.isOperational, false);
    assert.equal(err.cause, cause);
  });

  it('should be instanceof Error', () => {
    const err = new AppError('test');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof AppError);
  });
});

describe('ValidationError', () => {
  it('should set fields and 400 status', () => {
    const err = new ValidationError('bad input', { email: 'required' });
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'ERR_VALIDATION');
    assert.equal(err.name, 'ValidationError');
    assert.deepEqual(err.fields, { email: 'required' });
  });
});

describe('AuthenticationError', () => {
  it('should default message and 401 status', () => {
    const err = new AuthenticationError();
    assert.equal(err.message, 'Authentication required');
    assert.equal(err.statusCode, 401);
    assert.equal(err.code, 'ERR_AUTHENTICATION');
  });
});

describe('AuthorizationError', () => {
  it('should default message and 403 status', () => {
    const err = new AuthorizationError();
    assert.equal(err.message, 'Forbidden');
    assert.equal(err.statusCode, 403);
    assert.equal(err.code, 'ERR_AUTHORIZATION');
  });
});

describe('NotFoundError', () => {
  it('should format message with resource and id', () => {
    const err = new NotFoundError('User', 'usr-42');
    assert.equal(err.message, "User 'usr-42' not found");
    assert.equal(err.statusCode, 404);
  });

  it('should format message without id', () => {
    const err = new NotFoundError('Config');
    assert.equal(err.message, 'Config not found');
  });
});

describe('ConflictError', () => {
  it('should set 409 status', () => {
    const err = new ConflictError('duplicate delivery');
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, 'ERR_CONFLICT');
  });
});

describe('RateLimitError', () => {
  it('should set retryAfter and 429 status', () => {
    const err = new RateLimitError(30);
    assert.equal(err.statusCode, 429);
    assert.equal(err.retryAfter, 30);
    assert.match(err.message, /30s/);
  });
});

describe('Domain-specific errors', () => {
  const cases: Array<{
    ErrorClass: new (msg: string) => AppError;
    code: string;
    name: string;
  }> = [
    { ErrorClass: TriageError, code: 'ERR_TRIAGE', name: 'TriageError' },
    { ErrorClass: PlanningError, code: 'ERR_PLANNING', name: 'PlanningError' },
    { ErrorClass: ExecutionError, code: 'ERR_EXECUTION', name: 'ExecutionError' },
    { ErrorClass: ReviewError, code: 'ERR_REVIEW', name: 'ReviewError' },
    { ErrorClass: DeploymentError, code: 'ERR_DEPLOYMENT', name: 'DeploymentError' },
  ];

  for (const { ErrorClass, code, name } of cases) {
    it(`${name} should have code ${code}`, () => {
      const err = new ErrorClass('test');
      assert.equal(err.code, code);
      assert.equal(err.name, name);
      assert.equal(err.statusCode, 500);
      assert.ok(err instanceof AppError);
    });
  }
});
