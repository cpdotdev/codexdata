import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const output = fileURLToPath(new URL("../public/design.css", import.meta.url));
const css = ["theme.css", "docs.css"]
  .map((name) => readFileSync(require.resolve(`@codexpass/tokens/${name}`), "utf8"))
  .join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== css)
    throw new Error("Shared UI CSS is stale; run pnpm build:ui.");
} else {
  writeFileSync(output, css);
}
