/**
 * The browser viewer, one self-contained page. It decodes Simlock's lease stream with WebCodecs
 * (framing: 4-byte big-endian length, tag byte, payload; avcC description; AVCC NAL units) and speaks
 * serve-sim's input messages (tag byte + JSON; positions are 0–1 fractions). Both formats are from
 * Simlock's public docs and `src/core/screen.ts` / `src/core/input.ts` (MIT, callstackincubator/simlock).
 */
export const VIEWER_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tapdance viewer</title>
<style>
  :root { --bg:#f6f5f2; --fg:#1d1c1a; --muted:#6b675f; --line:#d9d5cc; --accent:#0b6e4f; --warn:#9a5b00; --bad:#a32020; --panel:#fffefb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141413; --fg:#ecebe7; --muted:#a29e94; --line:#34322e; --accent:#4fc39a; --warn:#e3a443; --bad:#f07070; --panel:#1c1b19; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.45 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:24px; max-width:1100px; margin:0 auto; padding:24px 16px; }
  @media (max-width: 760px) { main { grid-template-columns:1fr; } }
  .stage { display:flex; flex-direction:column; align-items:center; gap:12px; }
  canvas { max-height:78vh; max-width:100%; border-radius:18px; background:#000; touch-action:none; cursor:crosshair; box-shadow:0 0 0 1px var(--line); }
  .banner { width:100%; max-width:480px; padding:8px 12px; border-radius:8px; border:1px solid var(--line); background:var(--panel); font-size:14px; }
  .banner.human { border-color:var(--warn); color:var(--warn); }
  .row { display:flex; gap:8px; flex-wrap:wrap; justify-content:center; }
  button { font:inherit; padding:7px 12px; border-radius:8px; border:1px solid var(--line); background:var(--panel); color:var(--fg); cursor:pointer; }
  button:hover { border-color:var(--fg); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  aside { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; align-self:start; }
  aside h1 { font-size:16px; margin:0 0 12px; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:0 0 16px; font-size:14px; }
  dt { color:var(--muted); } dd { margin:0; word-break:break-word; }
  .muted { color:var(--muted); font-size:13px; }
  .err { color:var(--bad); }
  ul { padding-left:18px; margin:4px 0 0; font-size:13px; } a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <section class="stage">
    <div id="banner" class="banner">Connecting…</div>
    <canvas id="screen" width="390" height="844" aria-label="Live device screen; click or drag to interact"></canvas>
    <div class="row">
      <button id="takeover" class="primary">Take over</button>
      <button id="handback">Hand back to agent</button>
      <button data-button="back">Back</button>
      <button data-button="home">Home</button>
      <button data-button="app_switcher">Apps</button>
    </div>
    <div class="row">
      <button id="shot">Screenshot</button>
      <button id="rec">Start recording</button>
    </div>
    <p class="muted">Click to tap, drag to swipe, scroll to scroll. Type while the screen has focus. Your input pauses the agent for a few seconds; Take over pauses it until you hand back.</p>
  </section>
  <aside>
    <h1>Session</h1>
    <dl id="info"><dt>Status</dt><dd>loading…</dd></dl>
    <div class="muted">Recent artifacts</div>
    <ul id="artifacts"></ul>
  </aside>
</main>
<script>
"use strict";
const TAG = { description: 1, keyframe: 2, delta: 3, seed: 4, meta: 5, alive: 6, ended: 7 };
const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d");
const banner = document.getElementById("banner");
let decoder, meta, configured = false, waitingKey = true, frames = 0;
let state = { takeover: false, recording: null };

function setBanner(text, cls) { banner.textContent = text; banner.className = "banner" + (cls ? " " + cls : ""); }

function codecString(avcc) {
  const hex = (n) => n.toString(16).padStart(2, "0");
  return "avc1." + hex(avcc[1]) + hex(avcc[2]) + hex(avcc[3]);
}
function paint(frame, w, h) {
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.drawImage(frame, 0, 0, w, h);
}
function configure(avcc) {
  if (typeof VideoDecoder === "undefined") { setBanner("This browser has no WebCodecs; use a recent Chrome, Edge or Safari.", "human"); return; }
  if (decoder && decoder.state !== "closed") decoder.close();
  decoder = new VideoDecoder({
    output: (f) => { paint(f, f.displayWidth, f.displayHeight); f.close(); },
    error: (e) => { console.warn(e); waitingKey = true; },
  });
  decoder.configure({ codec: codecString(avcc), description: avcc, optimizeForLatency: true });
  configured = true; waitingKey = true;
}
async function jpeg(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  paint(bmp, bmp.width, bmp.height); bmp.close();
}
function onFrame(tag, payload) {
  if (tag === TAG.meta) { meta = JSON.parse(new TextDecoder().decode(payload)); canvas.width = meta.width; canvas.height = meta.height; return; }
  if (tag === TAG.description) { configure(payload.slice()); return; }
  if (tag === TAG.seed || (tag === TAG.delta && meta && meta.codec === "mjpeg")) { jpeg(payload.slice()); return; }
  if (tag === TAG.ended) { const r = JSON.parse(new TextDecoder().decode(payload)); setBanner("The lease ended (" + r.reason + "). This device is gone.", "human"); return; }
  if ((tag === TAG.keyframe || tag === TAG.delta) && configured) {
    if (tag === TAG.delta && waitingKey) return;
    if (tag === TAG.keyframe) waitingKey = false;
    try { decoder.decode(new EncodedVideoChunk({ type: tag === TAG.keyframe ? "key" : "delta", timestamp: frames++ * 33333, data: payload.slice() })); }
    catch (e) { waitingKey = true; }
  }
}
async function stream() {
  const res = await fetch("/stream");
  if (!res.ok) { const b = await res.json().catch(() => ({})); setBanner(b.error || "No live stream.", "human"); return; }
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const merged = new Uint8Array(buf.length + value.length); merged.set(buf); merged.set(value, buf.length); buf = merged;
    let off = 0; const view = new DataView(buf.buffer);
    while (buf.length - off >= 5) {
      const len = view.getUint32(off);
      if (buf.length - off - 4 < len) break;
      onFrame(buf[off + 4], buf.subarray(off + 5, off + 4 + len));
      off += 4 + len;
    }
    buf = buf.slice(off);
  }
  setBanner("Stream ended. Reload to reconnect.", "human");
}

// ---------------------------------------------------------------- input
let ws, down = false;
function send(tag, body) {
  if (!ws || ws.readyState !== 1) return;
  const json = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
  const m = new Uint8Array(1 + json.length); m[0] = tag; m.set(json, 1); ws.send(m);
}
function connectInput() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/input");
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    const b = new Uint8Array(e.data);
    if (b[0] === 0x82) { const c = JSON.parse(new TextDecoder().decode(b.subarray(1))); if (c.inputUnavailable) setBanner("This device takes no remote input; view only.", "human"); }
  };
  ws.onclose = (e) => { if (e.code !== 1000) setBanner("Input closed: " + (e.reason || e.code) + ". View only.", "human"); };
}
function pos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}
canvas.tabIndex = 0;
canvas.addEventListener("pointerdown", (e) => { canvas.focus(); canvas.setPointerCapture(e.pointerId); down = true; send(0x03, { type: "begin", ...pos(e) }); });
canvas.addEventListener("pointermove", (e) => { if (down) send(0x03, { type: "move", ...pos(e) }); });
const end = (e) => { if (!down) return; down = false; send(0x03, { type: "end", ...pos(e) }); };
canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
canvas.addEventListener("wheel", (e) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); send(0x0b, { dx: -e.deltaX / r.width, dy: -e.deltaY / r.height, ...pos(e) }); }, { passive: false });
const HID = { Enter:40, Escape:41, Backspace:42, Tab:43, Space:44, Minus:45, Equal:46, BracketLeft:47, BracketRight:48, Backslash:49, Semicolon:51, Quote:52, Backquote:53, Comma:54, Period:55, Slash:56, ArrowRight:79, ArrowLeft:80, ArrowDown:81, ArrowUp:82, ControlLeft:224, ShiftLeft:225, AltLeft:226, MetaLeft:227, ControlRight:228, ShiftRight:229, AltRight:230, MetaRight:231 };
function usage(code) {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) - 65 + 4;
  if (/^Digit[0-9]$/.test(code)) { const d = Number(code[5]); return d === 0 ? 39 : 29 + d; }
  return HID[code];
}
for (const type of ["keydown", "keyup"]) canvas.addEventListener(type, (e) => {
  const u = usage(e.code); if (u === undefined) return; e.preventDefault();
  send(0x06, { type: type === "keydown" ? "down" : "up", usage: u });
});
for (const b of document.querySelectorAll("[data-button]")) b.addEventListener("click", () => send(0x04, { button: b.dataset.button }));

// ---------------------------------------------------------------- session panel
async function post(path) { const r = await fetch(path, { method: "POST" }); const b = await r.json().catch(() => ({})); if (!r.ok) alert(b.error || r.status); return b; }
document.getElementById("takeover").onclick = async () => { await post("/api/takeover"); refresh(); };
document.getElementById("handback").onclick = async () => { await post("/api/handback"); refresh(); };
document.getElementById("shot").onclick = async () => { const b = await post("/api/screenshot"); if (b.artifact) refresh(); };
document.getElementById("rec").onclick = async () => { await post(state.recording ? "/api/record/stop" : "/api/record/start"); refresh(); };
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" })[c]); }
async function refresh() {
  const r = await fetch("/api/status"); const b = await r.json().catch(() => ({}));
  const info = document.getElementById("info");
  if (!r.ok) { info.innerHTML = '<dt>Status</dt><dd class="err">' + esc(b.error || r.status) + "</dd>"; return; }
  state = b; const d = b.device || {};
  if (d.error) { info.innerHTML = '<dt>Status</dt><dd class="err">' + esc(d.error) + "</dd>"; return; }
  const where = d.location ? (d.location.kind === "local" ? "this machine" : (d.location.workerLabel || d.location.workerId || d.location.endpoint)) : "";
  const rows = [["Device", d.model], ["Platform", (d.platform === "ios" ? "iOS " : "Android ") + d.osVersion], ["Worker", where], ["Lease", d.leaseId], ["Expires", d.expiresAt && new Date(d.expiresAt).toLocaleTimeString()], ["Control", b.takeover ? "you (agent paused)" : d.humanHoldUntil ? "you, briefly" : "agent"], ["Recording", b.recording ? "on" : "off"]];
  info.innerHTML = rows.filter((x) => x[1]).map((x) => "<dt>" + esc(x[0]) + "</dt><dd>" + esc(x[1]) + "</dd>").join("");
  document.getElementById("rec").textContent = b.recording ? "Stop recording" : "Start recording";
  // Simlock acts on Home only for iOS simulators; Back and Apps are Android keys.
  for (const name of ["back", "app_switcher"]) { const el = document.querySelector('[data-button="' + name + '"]'); if (el) { el.disabled = d.platform === "ios"; el.title = d.platform === "ios" ? "Android only" : ""; } }
  if (b.humanRequest) setBanner("The agent asks you: " + b.humanRequest.reason + " — press Take over, do it, then Hand back.", "human");
  else if (!banner.classList.contains("human") || b.takeover) setBanner(b.takeover ? "You have control. The agent is paused until you hand back." : "Live. The agent is driving; touch the screen to take control briefly.", b.takeover ? "human" : "");
  document.getElementById("artifacts").innerHTML = (b.artifacts || []).slice().reverse().map((a) => '<li><a target="_blank" href="/api/artifact?id=' + encodeURIComponent(a.id) + '">' + esc(a.kind) + "</a> " + esc(new Date(a.createdAt).toLocaleTimeString()) + "</li>").join("");
}
async function start() {
  const m = /k=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ k: m[1] }) });
    history.replaceState(null, "", "/");
    if (!r.ok) { setBanner("This link has expired. Run \"tapdance view\" again.", "human"); return; }
  }
  const probe = await fetch("/api/status");
  if (probe.status === 401) { setBanner("Open the link \"tapdance view\" printed (it carries a one-time key).", "human"); return; }
  stream().catch((e) => setBanner("Stream failed: " + e.message, "human"));
  connectInput();
  refresh(); setInterval(refresh, 3000);
}
start();
</script>
</body>
</html>`;
