export const BROWSER_RECOVERY_SCRIPT = `(() => {
  const script = document.currentScript;
  const original = script.dataset.launch;
  const waiting = script.dataset.waiting === "true";
  let pending = false;
  let navigating = false;
  let notice;
  function connectionNotice(message) {
    if (!message) { notice?.remove(); notice = undefined; return; }
    if (!notice) {
      notice = document.createElement("aside");
      notice.className = "waifus-recovery-notice";
      notice.setAttribute("role", "status");
      document.body.appendChild(notice);
    }
    notice.textContent = message;
  }
  async function check() {
    if (pending || navigating) return;
    pending = true;
    try {
      const response = await fetch("/_waifus_remote/resume-state", {
        credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) {
        connectionNotice(response.status === 403 ? "Remote access was disconnected. Reopen with waifus remote." : "Reconnecting…");
        return;
      }
      const state = await response.json();
      connectionNotice(state.direct === true ? "" : "Reconnecting…");
      if (state.direct === true && (waiting || state.launch !== original)) {
        navigating = true;
        // Keep the same isolated URL and fragment, but load the restarted host's bundle.
        window.location.reload();
      }
    } catch { connectionNotice("Reconnecting…"); /* Never request new authority. */ }
    finally { pending = false; }
  }
  setInterval(check, 2000);
  window.addEventListener("pageshow", check);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void check(); });
  void check();
})();`;

export function recoveryTag(launch: string, waiting = false): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(launch)) throw new TypeError("Invalid browser recovery launch.");
  return `<link rel="stylesheet" href="/_waifus_remote/resume.css"><script src="/_waifus_remote/resume.js" data-launch="${launch}" data-waiting="${waiting}" defer></script>`;
}

export function waitingDashboard(launch: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Waifus</title>${recoveryTag(launch, true)}</head><body><p>Reconnecting to your Waifus host…</p></body></html>`;
}
