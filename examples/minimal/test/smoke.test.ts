import { test } from 'node:test';
import assert from 'node:assert/strict';

// Import the compiled plugin module. The imports and the module-level
// declaration merging are exercised here: if the augmentations or the
// exported manifest are wrong, this import (and the property reads below) fail.
import * as plugin from '../src/index.js';
import type { Context } from '@deepseek-ai/cordis';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';

// --- A minimal fake Context ---------------------------------------------
// The real apply() runs inside a DSH composition where the harness builds a
// Context and resolves the webServer service. Here we hand it a hand-rolled
// stub that satisfies the Cordis surface this plugin touches, so we can
// exercise apply() outside DSH.
//
// Why we expose a dispose() teardown: the plugin registers a live setInterval
// through ctx.effect(). In real DSH the fiber unloads the plugin and runs the
// disposers, which clears that timer. Our fake MUST mirror that, otherwise the
// interval keeps the node:test event loop alive forever and the run hangs.
interface FakeContext {
  /** The stub Context passed to apply(). */
  ctx: Context;
  /** Run every collected disposer in order (mirrors fiber unload). */
  dispose(): void;
}

function makeFakeContext(): FakeContext {
  const disposers: Array<() => unknown> = [];
  const ctx = {
    // ctx.effect(body): run body now, keep its disposer for teardown. The
    // parameter type mirrors Cordis' Disposable<T> = () => T; strict mode needs
    // the param typed because the object is cast to Context at the end.
    effect(this: void, body: () => unknown) {
      const disp = body();
      if (typeof disp === 'function') disposers.push(disp as () => unknown);
      // Return a disposer matching Fiber.effect's shape.
      return () => disposers.splice(0).forEach((d) => d());
    },
    // ctx.emit(name): fire-and-forget; a no-op is enough for the smoke test.
    emit(): void {},
    // ctx.webServer.register(route): capture the route shape; return a
    // disposer. No real node:http server is created in this test.
    webServer: {
      register(_route: WebRoute): () => void {
        return () => {};
      },
    } as Context['webServer'],
  } as unknown as Context;
  return { ctx, dispose: () => disposers.splice(0).forEach((d) => d()) };
}

test('module loads and exports the plugin manifest', () => {
  // The Cordis loader looks up these named exports to build the runtime.
  assert.equal(plugin.name, 'skill-example');
  assert.deepEqual(plugin.inject, ['webServer']);
  assert.equal(typeof plugin.apply, 'function');
});

test('apply() throws on invalid config (fail loud at load)', () => {
  const { ctx } = makeFakeContext();
  // greeting is not a string -> must reject at load, not later.
  assert.throws(
    () => plugin.apply(ctx, { greeting: 42 as unknown as string }),
    /config.greeting must be a string/
  );
});

test('apply() accepts a valid config and registers the route', () => {
  const { ctx, dispose } = makeFakeContext();
  assert.doesNotThrow(() => plugin.apply(ctx, { greeting: 'hi' }));
  // Unload the fake fiber: this runs the effect disposers (clearing the
  // 60s interval) and releases the node:test event loop.
  dispose();
});
