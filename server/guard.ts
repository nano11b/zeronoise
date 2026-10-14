import type { Express, NextFunction, Request, Response, Router } from 'express';
import type { Socket } from 'socket.io';

/**
 * Crash safety helpers. One bad socket event, HTTP request, or timer tick must never take the process down.
 * Everything here only adds try/catch around existing handlers; behavior of a handler that does not throw is unchanged.
 */

/** Test-only failure hooks (socket event `test:throw`, GET /api/test/throw). Off unless this env var is exactly "1". */
export const crashTestHooks = process.env.CAMCHAT_TEST_CRASH_HOOKS === '1';

export const GENERIC_ERROR = 'Something went wrong. Try again.';

const RESERVED = new Set(['disconnect', 'disconnecting', 'error', 'newListener', 'removeListener']);

function errText(err: unknown): unknown {
  return err instanceof Error ? (err.stack || err.message) : err;
}

/**
 * Patch this socket's `on` so every handler registered afterwards is guarded:
 * sync throws and rejected promises are logged as `[socket] <event> failed` and, when the client passed an ack,
 * the ack gets `{ ok: false, error }` so the client does not wait for "did not respond".
 * Socket.IO acks only send once, so a handler that already answered is not answered twice.
 */
export function guardSocketHandlers(socket: Socket): void {
  const rawOn = socket.on.bind(socket) as (ev: string, fn: (...args: unknown[]) => unknown) => Socket;
  const fail = (event: string, args: unknown[], err: unknown) => {
    console.error(`[socket] ${event} failed`, errText(err));
    if (RESERVED.has(event)) return;
    const ack = args[args.length - 1];
    if (typeof ack === 'function') {
      try { (ack as (r: unknown) => void)({ ok: false, error: GENERIC_ERROR }); } catch { /* client gone */ }
    }
  };
  (socket as unknown as { on: unknown }).on = (event: string, handler: (...args: unknown[]) => unknown) => {
    if (typeof handler !== 'function') return rawOn(event, handler);
    return rawOn(event, (...args: unknown[]) => {
      try {
        const r = handler(...args);
        if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, (err) => fail(event, args, err));
      } catch (err) {
        fail(event, args, err);
      }
    });
  };
}

/** Wrap a timer/interval callback so a throw (or rejection) is logged instead of crashing the process. */
export function guardTimer<A extends unknown[]>(label: string, fn: (...args: A) => unknown): (...args: A) => void {
  return (...args: A) => {
    try {
      const r = fn(...args);
      if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, (err) => console.error(`[timer] ${label} failed`, errText(err)));
    } catch (err) {
      console.error(`[timer] ${label} failed`, errText(err));
    }
  };
}

type AnyHandler = (...args: unknown[]) => unknown;
const ROUTE_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'] as const;

/** Make a request handler's rejected promise reach next(err). Error handlers (4 args), routers and sub-apps are left alone. */
function wrapHandler(fn: unknown): unknown {
  if (typeof fn !== 'function') return fn;
  const f = fn as AnyHandler & { handle?: unknown; stack?: unknown; set?: unknown };
  if (f.length >= 4 || f.handle || f.stack) return fn;
  const wrapped = function (this: unknown, req: Request, res: Response, next: NextFunction) {
    const r = f.call(this, req, res, next);
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, next);
    return r;
  };
  return wrapped;
}

/**
 * Express 4 does not catch rejected promises from async handlers. Patch the route methods on this app/router
 * instance so every handler registered afterwards forwards rejections to the error middleware.
 */
export function asyncSafeRoutes(target: Express | Router): void {
  const t = target as unknown as Record<string, AnyHandler>;
  for (const m of ROUTE_METHODS) {
    const orig = t[m];
    if (typeof orig !== 'function') continue;
    t[m] = function (this: unknown, ...args: unknown[]) {
      // app.get('setting') reads a setting; leave that untouched.
      if (m === 'get' && args.length === 1 && typeof args[0] === 'string') return orig.apply(this, args);
      const mapped = args.map((a) => (Array.isArray(a) ? a.map(wrapHandler) : wrapHandler(a)));
      return orig.apply(this, mapped);
    };
  }
}

/** Last middleware: JSON errors. 4xx from body parsers keep their status; anything else is a logged 500. */
export function jsonErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const e = err as { status?: unknown; statusCode?: unknown };
  const st = Number(e?.status ?? e?.statusCode);
  const status = Number.isInteger(st) && st >= 400 && st < 600 ? st : 500;
  if (status >= 500) console.error(`[http] ${req.method} ${req.originalUrl.split('?')[0]} failed`, errText(err));
  if (res.headersSent) { next(err); return; }
  const message = status === 413 ? 'Request too large' : status < 500 ? 'Bad request' : 'Server error';
  res.status(status).json({ ok: false, error: message });
}

let processGuardsInstalled = false;
/**
 * unhandledRejection: log and keep running (a dropped promise does not leave shared state half-written in a way we can detect).
 * uncaughtException: log and exit(1) so systemd restarts a clean process; after an unknown sync throw the in-memory room
 * state may be inconsistent, so continuing is not provably safe. Handler-level guards above make this rare.
 */
export function installProcessGuards(): void {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;
  process.on('unhandledRejection', (reason) => {
    console.error('[process] unhandledRejection', errText(reason));
  });
  process.on('uncaughtException', (err, origin) => {
    console.error(`[process] uncaughtException (${origin}); exiting so the service manager restarts cleanly`, errText(err));
    process.exit(1);
  });
}
