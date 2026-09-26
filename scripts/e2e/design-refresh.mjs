import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, webkit, expect } from "@playwright/test";
const output = new URL(
  process.env.DESIGN_ARTIFACT_DIR || "../../.artifacts/design-refresh/",
  import.meta.url,
);
mkdirSync(output, { recursive: true });
// Failure modes: fabricated health on request failure, checked/fetched dates conflated,
// permanent failures hidden, a missing dataset label blocks the rest, no-JS docs disappear.
const results = [];
for (const [engine, launcher] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const browser = await launcher.launch();
  try {
    const page = await browser.newPage();
    let healthy = true,
      fail = false;
    await page.route("**/v1/codex/meta.json", (r) =>
      fail
        ? r.abort()
        : r.fulfill({
            json: {
              checked_at: "2026-09-25T12:00:00Z",
              fetched_at: "2026-09-24T12:00:00Z",
              client_version: "0.153.4",
              model_count: 12,
              source: { plan_label: "test-plan" },
            },
          }),
    );
    await page.route("**/healthz", (r) =>
      fail
        ? r.abort()
        : r.fulfill({
            status: healthy ? 200 : 503,
            json: { ok: healthy, permanent_failure: !healthy },
          }),
    );
    await page.goto("http://127.0.0.1:5191");
    await expect(page.locator("#mirror-health")).toHaveText("Healthy");
    await expect(page.locator("#catalog-checked")).toContainText("Sep 25");
    await expect(page.locator("#catalog-fetched")).toContainText("Sep 24");
    await expect(page.locator("#schema-tag")).toHaveText(/rust-v/);
    for (const width of [1440, 390, 320])
      for (const dark of [false, true]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate((d) => document.documentElement.classList.toggle("dark", d), dark);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false,
        );
        await page.screenshot({
          path: new URL(`${engine}-${width}-${dark ? "dark" : "light"}.png`, output).pathname,
          fullPage: true,
        });
        results.push({ engine, width, dark });
      }
    healthy = false;
    await page.reload();
    await expect(page.locator("#mirror-health")).toHaveText("Needs attention");
    fail = true;
    await page.reload();
    await expect(page.locator("#mirror-health")).toHaveText("Unavailable");
    await expect(page.locator("#catalog-checked")).toHaveText("Unavailable");
    await expect(page.getByRole("link", { name: "Open model catalog" })).toBeVisible();
    const nojs = await browser.newPage({ javaScriptEnabled: false });
    await nojs.goto("http://127.0.0.1:5191");
    await expect(nojs.getByRole("heading", { name: "Quick start" })).toBeVisible();
    await expect(
      nojs.getByRole("link", { name: "/v1/codex/models.json", exact: true }),
    ).toBeVisible();
    await expect(nojs.locator("#mirror-health")).toHaveText("See health endpoint");
    await nojs.close();
  } finally {
    await browser.close();
  }
}
writeFileSync(
  new URL("acceptance.json", output),
  JSON.stringify(
    {
      fixtures: "Synthetic same-origin metadata; real bundled static schema and features",
      checks: [
        "checked and fetched distinction",
        "health 503",
        "network failure stays unknown",
        "schema version",
        "no-JS docs",
        "responsive themes",
      ],
      results,
    },
    null,
    2,
  ),
);
console.log("CodexData progressive metadata, failure, no-JS and responsive checks passed.");
