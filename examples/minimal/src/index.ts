/**
 * dsh-plugin-dev — minimal example plugin.
 *
 * A REAL, compilable Cordis plugin for the DeepSeek Harness (DSH), kept tiny on
 * purpose so each concept is legible. It is a "function topology" plugin: it
 * exports name, an apply(ctx, config) entrypoint and an inject list.
 *
 * Honesty note on activation
 * --------------------------
 * This file type-checks and the smoke test runs it OUTSIDE DSH (no real HTTP
 * server, no bundle loader). Real activation happens inside a DSH profile via
 *   dsh plugin --profile <name> add <...>
 * where the harness builds a Context, resolves the webServer service and
 * calls apply(). We keep the route registration guarded so the module still
 * loads cleanly in the smoke test.
 */

import type { Context } from '@deepseek-ai/cordis';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { IncomingMessage, ServerResponse } from 'node:http';

// NOTE ON TYPES
// --------------
// We type-import WebRoute from @deepseek-ai/dsh-host-webserver for two reasons.
// 1) We get the route shape the register() call accepts instead of re-declaring
//    it. 2) More importantly, the import makes TypeScript load that package's
//    ambient augmentation, which is where Context.webServer is declared:
//
//      declare module '@deepseek-ai/cordis' {
//        interface Context { webServer: WebServer }
//        interface Events { 'webserver/index-inject'(...): void }
//      }
//
// That augmentation lives in the webserver package, not in cordis itself. A
// plugin that uses ctx.webServer MUST reference these types somewhere in its
// program (a type-only import is enough and costs zero at runtime). Without it,
// ctx.webServer fails to type-check.

/** The plugin's display name; must be stable per composition. */
export const name = 'skill-example';

/** Configuration contract (Cordis convention: name it Config). */
export interface Config {
  /** Optional greeting shown in the JSON route payload. */
  greeting?: string;
}

/** Declared service dependencies; the fiber stays PENDING until they resolve. */
export const inject = ['webServer'] as const;

/**
 * Plugin entrypoint. Runs once the webServer dependency resolves.
 *
 * TRAP (do not do this): the logger service is a Cordis core service. We do
 * NOT put it in inject here on purpose. Calling a service you did not declare
 * makes the load order implicit and hides missing-dependency bugs. If a
 * plugin needs logging it should accept it through a declared dependency (or
 * use the Node console directly). This example omits it to stay minimal.
 */
export function apply(ctx: Context, config: Config): void {
  // --- FAIL LOUD AT LOAD ---------------------------------------------------
  // A malformed config must blow up HERE, at load time (fiber -> FAILED), not
  // surface later as a null pointer deep inside a request handler.
  if (config.greeting !== undefined && typeof config.greeting !== 'string') {
    throw new TypeError('[skill-example] config.greeting must be a string, got ' + typeof config.greeting);
  }

  // --- ctx.effect + disposer (temporal reversibility) ----------------------
  // Anything not managed by a Cordis API (timers, sockets, watchers, child
  // processes) MUST be registered through ctx.effect(). The body runs
  // immediately and MUST return a disposer. On fiber unload (HMR, config
  // update, dependency loss) disposers run in REVERSE registration order
  // (LIFO), guaranteeing no orphaned timers leak past the plugin's life.
  ctx.effect(() => {
    const handle = setInterval(() => {
      // Emit our custom event on every tick (see Events augmentation below).
      ctx.emit('skill.example:ping');
    }, 60_000);
    // The disposer: kills the interval. Runs on fiber disposal, last-in-first-out.
    return () => clearInterval(handle);
  });

  // --- ctx.webServer.register (a route) -----------------------------------
  // The webServer service owns the node:http server. register() takes a
  // WebRoute object { kind, path, handler } and returns a disposer that removes
  // the route. 'exact' matches the pathname verbatim; 'prefix' matches p and
  // p/<anything>; duplicate (kind, path) throws at registration — collisions
  // are a composition-level contract violation (WebRoute in
  // @deepseek-ai/dsh-host-webserver).
  const route: WebRoute = {
    kind: 'exact',
    path: '/__skill-example',
    // Handler owns the full response lifecycle (it may hold the response
    // open, e.g. for SSE). Must settle and END the response itself.
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      // Fire the event again on HTTP hits so a subscriber observes both paths.
      ctx.emit('skill.example:ping');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          plugin: name,
          hello: config.greeting ?? 'world',
          ts: Date.now(),
        })
      );
    },
  };
  const removeRoute = ctx.webServer.register(route);

  // Register the route disposer with the fiber so it is cleaned up on unload.
  ctx.effect(() => removeRoute);
}

// --- Module augmentation (declaration merging) ----------------------------
// The harness extends Cordis' global view via declare module '@deepseek-ai/cordis'.
// Adding our custom event to Events gives end-to-end type safety for the event
// name — ctx.on/ctx.emit are typed against Events. Zero runtime cost: the
// declaration is erased at compile time.
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Fired on every heartbeat tick and every hit of /__skill-example. */
    'skill.example:ping'?: () => void;
  }
}
