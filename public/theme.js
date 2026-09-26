// Theme is presentation only; documentation remains readable without JavaScript.
(() => {
  const key = "codex-pass-theme";
  const modes = ["system", "light", "dark"];
  const names = { system: "System", light: "Light", dark: "Dark" };
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let mode = "system";
  try {
    const saved = localStorage.getItem(key);
    if (modes.includes(saved)) mode = saved;
  } catch {
    /* Storage can be disabled. */
  }
  function apply() {
    document.documentElement.classList.toggle(
      "dark",
      mode === "dark" || (mode === "system" && media.matches),
    );
    const button = document.getElementById("theme-toggle");
    if (button) {
      button.textContent = names[mode];
      button.setAttribute("aria-label", `Color theme: ${names[mode]}. Change theme`);
    }
  }
  apply();
  media.addEventListener("change", apply);
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.getElementById("theme-toggle").addEventListener("click", () => {
      mode = modes[(modes.indexOf(mode) + 1) % modes.length];
      try {
        localStorage.setItem(key, mode);
      } catch {
        /* Keep this page usable. */
      }
      apply();
    });
  });
})();
