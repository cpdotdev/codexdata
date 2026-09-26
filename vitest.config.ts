import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { outboundMock } from "./test/outbound-mock.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Fake secrets injected for tests; production uses `wrangler secret put`.
        bindings: {
          REFRESH_TOKEN_KEK: "dGVzdC1rZWstMzItYnl0ZXMtdGVzdC1rZWstMzItYnk=",
          ADMIN_TOKEN: "test-admin-token",
        },
        // Intercept every outbound fetch (including the OAuth refresh inside the DO): tests never
        // reach the network.
        outboundService: outboundMock,
        // Disable the Cache API in tests: Miniflare implements it with an internal DO, and `reset()`
        // would interrupt in-flight waitUntil(cache.put) calls into a string of harmless but noisy
        // uncaught exceptions.
        cacheAPI: false,
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
