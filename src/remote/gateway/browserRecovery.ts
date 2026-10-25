export const BROWSER_RECOVERY_SCRIPT = `(() => {
  const script = document.currentScript;
  const original = script.dataset.launch;
  const waiting = script.dataset.waiting === "true";
  let pending = false;
  let navigating = false;
  let notice;
  function connectionNotice(message, tone) {
    // The waiting page shows its own status line instead of the floating notice.
    const status = waiting ? document.getElementById("waifus-waiting-status") : null;
    if (status) {
      status.textContent = message || "Connecting…";
      status.dataset.tone = tone || "warn";
      return;
    }
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
        connectionNotice(response.status === 403 ? "Remote access was disconnected. Reopen with waifus remote." : "Reconnecting…", response.status === 403 ? "err" : "warn");
        return;
      }
      const state = await response.json();
      connectionNotice(state.direct === true ? (waiting ? "Connected, opening the dashboard…" : "") : "Reconnecting…", state.direct === true ? "ok" : "warn");
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

// The dashboard's fused-cell look (white cells on an ink field, 1px seams, size as hierarchy),
// self-contained: the host's bundle and its fonts are what this page is waiting for. Inline styles
// are allowed by the dashboard CSP; the only script is the same-origin recovery script.
const WAITING_STYLE = `
:root{color-scheme:light dark;--field:#141414;--paper:#fff;--text:#141414;--mute:#8a8a8a;
--butter:#ffe97a;--mint:#5ef2c1;--danger:#ffb3b3;--sans:"Helvetica Neue",-apple-system,BlinkMacSystemFont,Arial,sans-serif;
--mono:"SF Mono",Menlo,Monaco,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--field:#000;--paper:#161616;--text:#f2f2f2;--mute:#8f8f8f}}
*{margin:0;padding:0;box-sizing:border-box}
html,body{min-height:100%}
body{background:var(--field);color:var(--text);font:14px/1.5 var(--sans)}
.waiting{min-height:100vh;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:96px 1fr auto;gap:1px;padding:1px;background:var(--field)}
.cell{background:var(--paper)}
.brand{display:flex;align-items:center;gap:14px;padding:0 26px}
.mark{width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;background:var(--text);color:var(--paper);font-size:15px}
.title{font-size:21px;letter-spacing:-0.01em}
.hero{display:flex;flex-direction:column;justify-content:flex-end;gap:18px;padding:32px 26px}
.eyebrow{font:10px/1.2 var(--mono);letter-spacing:0.14em;text-transform:uppercase;color:var(--mute)}
h1{font-weight:400;font-size:clamp(36px,7vw,76px);line-height:0.95;letter-spacing:-0.04em;max-width:820px}
.hero p:not(.eyebrow){max-width:620px;color:var(--mute);font-size:15px}
.foot{display:flex;flex-wrap:wrap;align-items:center;gap:12px 18px;padding:16px 26px}
.chip{display:inline-block;padding:7px 10px;font:11px var(--mono);letter-spacing:0.08em;text-transform:uppercase;color:#141414;background:var(--butter)}
.chip[data-tone="ok"]{background:var(--mint)}
.chip[data-tone="err"]{background:var(--danger);text-transform:none;letter-spacing:0}
.hint{color:var(--mute);font-size:12.5px}
code{font:12px var(--mono);color:var(--text);user-select:all}
.waifus-recovery-notice{display:none}
`.replace(/\n/g, "");

/** Shown instead of the dashboard until the host answers over the direct path; it reloads itself. */
export function waitingDashboard(launch: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Discord Waifus</title><style>${WAITING_STYLE}</style>${recoveryTag(launch, true)}</head><body><main class="waiting"><header class="cell brand"><span class="mark">W</span><span class="title">Discord Waifus</span></header><section class="cell hero"><p class="eyebrow">Remote Access</p><h1>Waiting for your host</h1><p>Your dashboard opens here by itself as soon as the host answers over the direct connection. This page checks again every few seconds, so there is nothing to do.</p></section><footer class="cell foot"><span id="waifus-waiting-status" class="chip" data-tone="warn" role="status">Connecting…</span><span class="hint">The host must be running and awake. To manage saved hosts, run <code>waifus remote --setup</code>.</span></footer></main></body></html>`;
}
