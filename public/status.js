// Progressive metadata only. Endpoint links and all documentation work without JS.
// Static datasets are fetched relative to this page (works on any host, including a
// GitHub Pages subpath); the live catalog metadata and health come from the Worker origin
// declared in <meta name="codexdata-live-origin">.
(() => {
  const set = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  };
  const live = (
    document.querySelector('meta[name="codexdata-live-origin"]')?.content ?? ""
  ).replace(/\/+$/, "");
  const date = (value) => {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "Unavailable";
    return new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    }).format(new Date(value));
  };
  async function json(path, allowUnhealthy = false) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(path, { signal: controller.signal });
      if (!response.ok && !(allowUnhealthy && response.status === 503))
        throw new Error("Unavailable");
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
  json(`${live}/v1/codex/meta.json`)
    .then((meta) => {
      set("catalog-checked", date(meta.checked_at));
      set("catalog-fetched", date(meta.fetched_at));
      set(
        "catalog-plan",
        typeof meta.source?.plan_label === "string" ? meta.source.plan_label : "Not specified",
      );
    })
    .catch(() =>
      ["catalog-checked", "catalog-fetched", "catalog-plan"].forEach((id) =>
        set(id, "Unavailable"),
      ),
    );
  json(`${live}/healthz`, true)
    .then((health) => {
      const text =
        health.ok === true ? "Healthy" : health.ok === false ? "Needs attention" : "Unavailable";
      set("mirror-health", text);
      document.getElementById("mirror-health").dataset.state =
        health.ok === true ? "success" : "warning";
    })
    .catch(() => set("mirror-health", "Unavailable"));
  for (const [id, path] of [
    ["schema-tag", "v1/schema/codex-model-info/index.json"],
    ["features-tag", "v1/features/codex/index.json"],
  ]) {
    json(path)
      .then((data) =>
        set(id, typeof data.latest?.tag === "string" ? data.latest.tag : "Unavailable"),
      )
      .catch(() => set(id, "Unavailable"));
  }
})();
