/**
 * The API route must belong to the plugin fiber, never to what `apply` returns.
 *
 * cordis constructs a function-declaration plugin with `new` and reads only
 * `init`/`initHooks` off the result, so a disposer merely *returned* by `apply`
 * is dropped. That is how the route used to outlive its fiber: disabling the
 * plugin left `/api/dsh-helloai-bak` registered and enabling it again failed
 * with `webserver: duplicate prefix route`.
 *
 *   node test-route-lifecycle.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";

const home = await mkdtemp(join(tmpdir(), "dsh-helloai-route-home-"));
process.env.DSH_HOME = home;

/** The webserver's registration contract: distinct named routes, disposer back. */
class WebServer extends Service {
  prefixes = new Map();
  constructor(ctx) {
    super(ctx, "webServer");
  }
  register(route) {
    if (this.prefixes.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
    this.prefixes.set(route.path, route);
    return () => {
      this.prefixes.delete(route.path);
    };
  }
}
class WebRuntime extends Service {
  trustedHosts = [];
  constructor(ctx) {
    super(ctx, "webRuntime");
  }
}

const PREFIX = "/api/dsh-helloai-bak";
const ctx = new Context();
const webServer = new WebServer(ctx);
new WebRuntime(ctx);
// The module namespace itself, exactly what the loader hands to ctx.plugin().
const plugin = await import("./lib/index.js");

try {
  const first = await ctx.plugin(plugin);
  assert.ok(webServer.prefixes.has(PREFIX), "activation registers the prefix route");

  await first.dispose();
  assert.ok(!webServer.prefixes.has(PREFIX), "dispose releases the prefix route");

  const second = await ctx.plugin(plugin);
  assert.ok(webServer.prefixes.has(PREFIX), "re-activating after a dispose registers it again");
  await second.dispose();

  // A route leaked by a build predating this test has no fiber behind it; the
  // next activation takes it over instead of failing on the duplicate.
  webServer.prefixes.set(PREFIX, { kind: "prefix", path: PREFIX, handler: () => {} });
  const third = await ctx.plugin(plugin);
  assert.ok(webServer.prefixes.has(PREFIX), "a leaked route is taken over");
  await third.dispose();
  assert.ok(!webServer.prefixes.has(PREFIX), "dispose releases the taken-over route");
} finally {
  await rm(home, { recursive: true, force: true });
}

console.log("route lifecycle: all checks passed\n");
