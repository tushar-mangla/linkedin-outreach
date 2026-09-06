import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { DEFAULT_OPERATOR_ID } from '../types.js';

export interface RequestContext {
  tenantId: string;
  operatorId: string;
  correlationId: string;
  devAuth: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestContext?: RequestContext;
    }
  }
}

const SINGLE_USER_TENANT_FALLBACK = '00000000-0000-0000-0000-000000000001';

/**
 * Explicit development-only identity adapter. It is isolated behind
 * DEV_AUTH_ENABLED and must be replaced by production authentication.
 * Never reads tenant/operator identity from request bodies.
 */
export function resolveDevContext(): RequestContext | undefined {
  // Fail closed: dev identity exists only when explicitly enabled AND never in production.
  if (process.env.NODE_ENV === 'production') return undefined;
  if (process.env.DEV_AUTH_ENABLED !== '1') return undefined;
  const tenantId = process.env.SINGLE_USER_TENANT_ID ?? SINGLE_USER_TENANT_FALLBACK;
  const operatorId = process.env.SINGLE_USER_OPERATOR_ID ?? DEFAULT_OPERATOR_ID;
  if (!tenantId || !operatorId) return undefined;
  return { tenantId, operatorId, correlationId: randomUUID(), devAuth: true };
}

export function requestContextMiddleware(request: Request, response: Response, next: NextFunction): void {
  const context = resolveDevContext();
  if (!context) {
    response.status(401).json({
      status: 'refused',
      code: 'AUTH_CONTEXT_REQUIRED',
      message: 'Authenticated operator context is required',
      correlationId: randomUUID(),
    });
    return;
  }
  request.requestContext = { ...context, correlationId: request.header('x-correlation-id') ?? context.correlationId };
  response.setHeader('x-correlation-id', request.requestContext.correlationId);
  next();
}

export function requireRequestContext(request: Request): RequestContext {
  const context = request.requestContext;
  if (!context?.tenantId || !context?.operatorId) {
    throw new Error('AUTH_CONTEXT_REQUIRED');
  }
  return context;
}

export function structuredRefusal(code: string, message: string, correlationId: string, currentState?: unknown) {
  return { status: 'refused' as const, code, message, correlationId, ...(currentState !== undefined ? { currentState } : {}) };
}
