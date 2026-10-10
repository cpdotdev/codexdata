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
          // TEST-ONLY signing keys (test/fixtures.ts): the shared format test vector and a
          // second key for rotation. Overrides the production list in wrangler.jsonc.
          CATALOG_SIGNING_PUBLIC_KEYS:
            "SuxU8H8gxEBdAdAX9_-DtBtEaVSNvwtwkak1JGCnl5s,\n CAtY-p-zYUSkwpCfopdnaBgUkg702k7l4A9FCUKyIZE",
          // Tests start in transition mode; the enforcement tests switch it on themselves
          // (withSignatureRequired in test/coordinator.test.ts). Production enforces it.
          CATALOG_SIGNATURE_REQUIRED: "false",
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
