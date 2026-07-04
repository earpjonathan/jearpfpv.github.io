/* ============================================================
   Hidden minigame for the hub cover — a top-down trail run.
   Double-click the background and a little hiker (dark mode) or
   skier (light mode) drops onto the contour map and BECOMES your
   cursor (Pointer Lock API).

   On start the game samples a few terrain offsets and freezes the
   one with the best spread of peaks, valleys and rideable slopes,
   then lays out the course on it. Footing is directional: hold
   still / climb / sit on a top and your edges grip; steer downhill
   and they let go so gravity takes you. A fall-line arrow + relief
   shading + peak flags show the lay of the land.

   Around the map: short ski lifts (ski mode, valley -> peak, kept
   clear of the courses), a fenced JUMP park (hit a ramp, then Space
   / click in the air to spin for trick points) and a fenced SLALOM
   course (thread the gates for combo points). In hike mode, blue
   streams wind downhill and you can drift down them (steer hard to
   climb out). Bomb a hill for speed lines; snow drifts in ski mode.

   The page stays usable — aim at a section and click to open it,
   aim at the theme toggle to morph skier<->hiker, click open ground
   (or Esc) to leave. Everything rides on its own overlay canvas, so
   the shared topo.js is untouched on other pages.
   ============================================================ */
(function () {
  if (!document.body.classList.contains("is-cover")) return;        // hub only
  if (matchMedia("(hover: none)").matches) return;                  // needs a cursor

  /* ---- tunables (tweak to taste) ---- */
  var SENS = 0.85;          // mouse delta -> velocity
  var SMOOTH = 0.5;         // input smoothing (de-twitch)
  var RESPONSE = 0.30;      // how fast velocity chases its target (inertia/glide)
  var CLIMB_K = 2.2;        // how much a slope fights an uphill push (lower = easier climb)
  var CLIMB_MIN = 0.5;      // a climb is never fully blocked
  var DOWN_FACTOR = 0.7;    // input authority pointing downhill (higher = slides more)
  var GRAV = 54;            // gravity drift strength (the downhill "drag")
  var GRIP = 5.4;           // footing: holds you while idle / climbing / on a top
  var DOWN_RELEASE = 1.0;   // how readily a downhill push lets the edges go
  var GRIP_SPEED = 4.2;     // moving faster than this and you can't just plant
  var CLIMB_GRIP = 16;      // climbing keeps its footing up to ~this speed (so peaks are reachable)
  var STOP_DAMP = 0.70;     // extra damping while planted (settle to a real stop)
  var MAXSPEED = 16;        // speed clamp
  var GRAD_E = 24;          // slope-sampling radius — bigger = smoother, "map" feel
  var SCORE_RATE = 0.5;     // points per unit of downhill speed
  var SLIDE_THRESH = 2.2;   // downhill speed that flips walk -> slide animation
  var TOP_MARGIN = 14;      // keep the character on-screen below the very top
  var N_TREES = 28;
  var TREE_POOL = 44;       // trees kept alive across the scrolling region (denser than on-screen count)
  var POP_DUR = 440;        // tree pop-in duration (ms)
  var WIPE_TIME = 38;       // wipeout duration (frames)
  var N_LIFTS = 2;          // ski lifts per run
  var LIFT_SPEED = 1.9;     // px/frame up the cable
  var LIFT_ATTACH = 26;     // proximity to a base station to grab the lift
  var LIFT_MIN = 140, LIFT_MAX = 360;   // cable length window (short, spaced)
  var JUMP_MIN_SP = 3.0;    // speed needed to launch off a ramp
  var JUMP_R = 22;          // ramp catch radius (wider ramps)
  var AIR_TIME = 46;        // airborne frames
  var TRICK_PTS = 70;       // points banked per trick input (max 4 / jump)
  var SLALOM_GATES = 6;
  var GATE_HW = 24;         // half-width of a gate opening (wider = easier to thread)
  var GATE_SHIFT = 28;      // how far gates alternate off the centerline
  var GATE_STEP_Y = 60;     // even vertical spacing between gates
  var STREAM_SPEED = 2.4;   // drift speed down a stream
  var STREAM_EXIT = 4.2;    // input strength needed to climb out of a stream
  var SPEED_LINE_TH = 7;    // speed at which speed-lines kick in
  var N_SNOW = 70;
  var WATER = "#3f6c88", WATER_HI = "#83b4d6";   // on-theme river blue

  function topoReady() { return window.__topo && window.__topo.ready && window.__topo.ready(); }

  /* ---- overlay canvas (above contours, below the menu, click-through) ---- */
  var cv = document.createElement("canvas");
  cv.className = "game-layer";
  cv.setAttribute("aria-hidden", "true");
  document.body.appendChild(cv);
  var ctx = cv.getContext("2d");
  var dpr = Math.min(window.devicePixelRatio || 1, 2), W = 0, H = 0;
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  /* ---- HUD + hint ---- */
  var hud = document.createElement("div"); hud.className = "game-hud"; document.body.appendChild(hud);
  var hint = document.createElement("div"); hint.className = "game-hint";
  hint.textContent = "⛰ Double-click the hills — ski the contours"; document.body.appendChild(hint);

  /* ---- theme colors ---- */
  var C = {}, FONT = '"Plus Jakarta Sans", sans-serif';
  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    function v(n, d) { return (cs.getPropertyValue(n) || d).trim() || d; }
    C.fg = v("--fg", "#f2efe6");
    C.accent = v("--accent", "#dc5000");
    C.soft = v("--fg-soft", "#6c5f51");
    FONT = (cs.getPropertyValue("--font") || FONT).trim() || FONT;
  }
  readColors();
  new MutationObserver(function () { readColors(); if (active) refreshShade(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  var TREE_TOP = "#7c8a52", TREE_DK = "#566237";

  /* ---- state ---- */
  var active = false, raf = null, locked = false, lastStopAt = -9999;
  var chr = newChar();
  function newChar() {
    return { x: W / 2, y: H / 2, vx: 0, vy: 0, ang: 0, walk: 0, sliding: false, speed: 0,
             wipe: 0, spin: 0, tumble: 0,
             onLift: null, lt: 0, liftCool: 0,
             air: 0, airMax: AIR_TIME, airH: 0, avx: 0, avy: 0, trick: 0, trickPts: 0, trickSpin: 0, flip: 0, flipV: 0, airCool: 0,
             inStream: null, streamF: 0, bob: 0, treeCool: 0,
             combo: 0, flash: "", flashT: 0 };
  }
  var pendingX = 0, pendingY = 0, smInX = 0, smInY = 0;
  var freeMouse = { x: W / 2, y: H / 2 };
  var trees = [], trail = [], spray = [], lifts = [], shade = null;
  var jumps = [], gates = [], jumpZone = null, slalomZone = null, streams = [], snow = [], peaks = [];
  var letterRect = null, lodge = null, tent = null, confetti = [], slalomCleared = false;
  /* infinite map: a deadzone camera scrolls the world under the character */
  var cam = { x: 0, y: 0 }, base = { x: 0, y: 0 }, scrollDir = { x: 0, y: 0 };
  var shadeCanvas = null, shadeCtx = null, shadeImg = null, shadeVals = null, shadeW = 0, shadeH = 0, shadeSc = 12;
  var score = 0, best = 0, aimEl = null;
  try { best = +localStorage.getItem("topoBest") || 0; } catch (e) {}

  function mode() { return document.documentElement.dataset.theme === "light" ? "ski" : "hike"; }
  function field(x, y) { return window.__topo.field(x, y); }
  function grad(x, y) {
    var e = GRAD_E;
    return [field(x + e, y) - field(x - e, y), field(x, y + e) - field(x, y - e)];
  }
  function slopeAt(x, y) { var g = grad(x, y); return Math.hypot(g[0], g[1]); }
  function hexRgb(h) {
    h = (h || "").replace("#", ""); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16); return isNaN(n) ? [240, 237, 230] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  /* keep-out regions: the menu words + the course boxes */
  function inRect(x, y, r) { return !!r && x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h; }
  function inCourse(x, y) { return inRect(x, y, jumpZone) || inRect(x, y, slalomZone); }
  function inLetters(x, y) { return inRect(x, y, letterRect); }
  function getMenuRect() {
    var el = document.querySelector(".menu"); if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: r.left - 22, y: r.top - 16, w: r.width + 44, h: r.height + 32 };
  }

  /* ---- pointer lock helpers ---- */
  function lockEl() { return document.pointerLockElement || document.mozPointerLockElement || null; }
  function requestLock() {
    var el = document.body;
    var fn = el.requestPointerLock || el.mozRequestPointerLock || el.webkitRequestPointerLock;
    if (fn) { try { var p = fn.call(el); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
  }
  function exitLock() {
    var fn = document.exitPointerLock || document.mozExitPointerLock || document.webkitExitPointerLock;
    if (fn) { try { fn.call(document); } catch (e) {} }
  }

  /* ---- lifecycle ---- */
  function start(x, y) {
    if (!topoReady()) return;
    readColors();
    if (!active) pickGoodTerrain();              // choose a snapshot once per run (not on reposition)
    window.__topo.freeze(true);                  // hold those hills still to ski on
    chr = newChar(); chr.x = x; chr.y = y;
    freeMouse.x = x; freeMouse.y = y;
    pendingX = pendingY = smInX = smInY = 0;
    if (!active) {
      score = 0; slalomCleared = false; confetti = [];
      cam.x = cam.y = 0; scrollDir.x = scrollDir.y = 0;
      letterRect = getMenuRect();
      findPeaks(); buildCourses(); spawnTrees(); buildLifts(); buildStreams(); buildLandmarks(); buildSnow();
    }
    refreshShade();
    active = true;
    document.body.classList.add("game-on");
    hud.classList.add("is-on");
    hideHint();
    requestLock();
    if (raf == null) raf = requestAnimationFrame(loop);
  }
  function stop() {
    if (!active) return;
    active = false;
    lastStopAt = performance.now();
    window.__topo.freeze(false);
    document.body.classList.remove("game-on");
    hud.classList.remove("is-on");
    clearAim();
    if (lockEl()) exitLock();
    locked = false;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    ctx.clearRect(0, 0, W, H);
    trees = []; trail = []; spray = []; lifts = []; shade = null;
    jumps = []; gates = []; streams = []; snow = []; peaks = [];
    confetti = []; lodge = null; tent = null;
  }

  /* pick a terrain offset with a wide elevation range and lots of rideable slope */
  function pickGoodTerrain() {
    if (!window.__topo.setOffset) return;
    var best = null, bestSc = -1;
    for (var c = 0; c < 16; c++) {
      var px = (Math.random() * 2 - 1) * 5000, py = (Math.random() * 2 - 1) * 5000;
      window.__topo.setOffset(px, py);
      var mn = 1e9, mx = -1e9, ride = 0, n = 0;
      for (var y = 120; y < H - 60; y += 48) for (var x = 60; x < W - 60; x += 48) {
        var e = field(x, y); if (e < mn) mn = e; if (e > mx) mx = e;
        var s = slopeAt(x, y); if (s > 0.03 && s < 0.14) ride++; n++;
      }
      var sc = (mx - mn) * (n ? ride / n : 0);
      if (sc > bestSc) { bestSc = sc; best = { px: px, py: py }; }
    }
    if (best) { window.__topo.setOffset(best.px, best.py); base.x = best.px; base.y = best.py; }
  }

  function spawnTrees() {
    trees = []; var now = performance.now();
    for (var i = 0; i < N_TREES; i++) {
      var tx, ty, tries = 0;
      do { tx = 40 + Math.random() * (W - 80); ty = 120 + Math.random() * (H - 210); tries++; }
      while (tries < 16 && (inCourse(tx, ty) || inLetters(tx, ty)));   // never on a course or the words
      if (inCourse(tx, ty)) continue;
      trees.push({ x: tx, y: ty, size: 9 + Math.random() * 8, born: now + i * 26 + Math.random() * 90 });
    }
  }

  /* local maxima of the frozen field -> little summit flags */
  function findPeaks() {
    peaks = []; var pts = [];
    for (var y = 110; y < H - 70; y += 34) for (var x = 70; x < W - 70; x += 34) pts.push({ x: x, y: y, e: field(x, y) });
    pts.sort(function (a, b) { return b.e - a.e; });            // highest first
    for (var i = 0; i < pts.length && peaks.length < 3; i++) {  // up to 3, spaced apart
      var ok = true;
      for (var p = 0; p < peaks.length; p++) if (Math.hypot(pts[i].x - peaks[p].x, pts[i].y - peaks[p].y) < 150) ok = false;
      if (ok) peaks.push(pts[i]);
    }
  }

  /* best sloped anchor inside an x-band (a margin beside the menu words) */
  function pickAnchorBand(x0, x1, y0, y1) {
    if (x1 - x0 < 90) return null;
    var best = null;
    for (var y = y0; y < y1; y += 24) for (var x = x0; x < x1; x += 24) {
      var s = slopeAt(x, y); if (s < 0.03 || s > 0.13) continue;
      var sc = field(x, y) * 0.6 + s;
      if (!best || sc > best.sc) best = { x: x, y: y, sc: sc };
    }
    return best || { x: (x0 + x1) / 2, y: y0 + 24 };
  }
  /* a high, sloped start whose downhill heads DOWN the screen — so the slalom
     that follows the fall line from it always runs downhill */
  function pickSlalomStart(x0, x1, y0, y1) {
    if (x1 - x0 < 90) return null;
    var best = null;
    for (var y = y0; y < y1; y += 22) for (var x = x0; x < x1; x += 22) {
      var g = grad(x, y), gm = Math.hypot(g[0], g[1]);
      if (gm < 0.035 || gm > 0.13) continue;
      var downY = -g[1] / gm;                          // >0 means downhill is downward on screen
      if (downY < 0.3) continue;
      var sc = field(x, y) * 0.5 + downY * 0.6 + gm;   // prefer high, downward, sloped
      if (!best || sc > best.sc) best = { x: x, y: y, sc: sc };
    }
    return best;
  }
  function bbox(pts, pad) {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (var i = 0; i < pts.length; i++) { x0 = Math.min(x0, pts[i].x); y0 = Math.min(y0, pts[i].y); x1 = Math.max(x1, pts[i].x); y1 = Math.max(y1, pts[i].y); }
    return { x: x0 - pad, y: y0 - pad, w: (x1 - x0) + pad * 2, h: (y1 - y0) + pad * 2 };
  }

  /* one jump course + one slalom course; the makers place them anywhere — on-screen
     at the start, off-screen ahead as the world scrolls (managed in manageWorld) */
  function buildCourses() {
    jumps = []; gates = []; jumpZone = slalomZone = null;
    var L = letterRect, gap = 32;
    var leftX1 = L ? L.x - gap : W * 0.42, rightX0 = L ? L.x + L.w + gap : W * 0.58;
    var rja = pickAnchorBand(rightX0, W - 44, H * 0.16, H * 0.5);
    if (rja) makeJumpCourse(rja.x, rja.y);
    var sla = pickSlalomStart(44, leftX1, H * 0.12, H * 0.5) || pickAnchorBand(44, leftX1, H * 0.14, H * 0.42);
    if (sla) makeSlalomCourse(sla.x, sla.y);
  }
  /* 3 ramps stepping down the fall line from (ax, ay) */
  function makeJumpCourse(ax, ay) {
    jumps = []; jumpZone = null;
    var jx = ax, jy = ay;
    for (var i = 0; i < 3; i++) {
      var gj = grad(jx, jy), gmj = Math.hypot(gj[0], gj[1]) || 1e-6;
      jumps.push({ x: jx, y: jy, dx: -gj[0] / gmj, dy: -gj[1] / gmj });
      jx += (-gj[0] / gmj) * 60; jy += Math.max(58, (-gj[1] / gmj) * 78);
    }
    jumpZone = bbox(jumps, 28);
  }
  /* gates alternating across a fall line traced from (ax, ay) — always downhill */
  function makeSlalomCourse(ax, ay) {
    gates = []; slalomZone = null; slalomCleared = false;
    var cl = [{ x: ax, y: ay }], cx0 = ax, cy0 = ay;
    for (var s = 0; s < SLALOM_GATES + 2; s++) {
      var gg = grad(cx0, cy0), gmg = Math.hypot(gg[0], gg[1]);
      if (gmg < 0.012) break;                                 // flat -> stop tracing (no bunched gates)
      cx0 += (-gg[0] / gmg) * GATE_STEP_Y; cy0 += (-gg[1] / gmg) * GATE_STEP_Y;
      cl.push({ x: cx0, y: cy0 });
    }
    if (cl.length < 3) return;                                // not enough slope here for a course
    var poles = [];
    for (var k = 1; k < cl.length && gates.length < SLALOM_GATES; k++) {
      var a = cl[k - 1], b = cl[k], ddx = b.x - a.x, ddy = b.y - a.y, dl = Math.hypot(ddx, ddy) || 1e-6;
      ddx /= dl; ddy /= dl;
      var px2 = -ddy, py2 = ddx, side = (k % 2 ? 1 : -1);
      var cx = b.x + px2 * side * GATE_SHIFT, cy = b.y + py2 * side * GATE_SHIFT;
      gates.push({ cx: cx, cy: cy, nx: ddx, ny: ddy, px: px2, py: py2, hw: GATE_HW, passed: false, prev: 0 });
      poles.push({ x: cx + px2 * GATE_HW, y: cy + py2 * GATE_HW }, { x: cx - px2 * GATE_HW, y: cy - py2 * GATE_HW });
    }
    if (gates.length) slalomZone = bbox(poles, 22);
  }

  /* short, spaced, non-crossing lifts from a basin to a nearby peak — never inside a course */
  function buildLifts() {
    lifts = [];
    var pts = [];
    for (var y = 130; y < H - 70; y += 40) for (var x = 60; x < W - 60; x += 40) pts.push({ x: x, y: y, e: field(x, y) });
    if (pts.length < 6) return;
    pts.sort(function (a, b) { return a.e - b.e; });
    var lows = pts.slice(0, Math.max(4, (pts.length / 5) | 0));
    var highs = pts.slice(-Math.max(4, (pts.length / 5) | 0));
    function ccw(ax, ay, bx, by, cx, cy) { return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax); }
    function crosses(a, b, c, d) {
      return ccw(a.x, a.y, c.x, c.y, d.x, d.y) !== ccw(b.x, b.y, c.x, c.y, d.x, d.y) &&
             ccw(a.x, a.y, b.x, b.y, c.x, c.y) !== ccw(a.x, a.y, b.x, b.y, d.x, d.y);
    }
    var tries = 0;
    while (lifts.length < N_LIFTS && tries++ < 600) {
      var base = lows[(Math.random() * lows.length) | 0], cand = null, bestGain = -1;
      for (var h = 0; h < highs.length; h++) {
        var t2 = highs[h], d = Math.hypot(t2.x - base.x, t2.y - base.y);
        if (d < LIFT_MIN || d > LIFT_MAX || t2.e - base.e <= 0) continue;
        if (inCourse(base.x, base.y) || inCourse(t2.x, t2.y) || inLetters(base.x, base.y) || inLetters(t2.x, t2.y)) continue;  // ends stay clear of courses + words (cable may cross)
        var ok = true;
        for (var L = 0; L < lifts.length; L++) {
          var Lf = lifts[L];
          if (Math.hypot(base.x - Lf.bx, base.y - Lf.by) < 150 || Math.hypot(t2.x - Lf.tx, t2.y - Lf.ty) < 150 ||
              crosses(base, t2, { x: Lf.bx, y: Lf.by }, { x: Lf.tx, y: Lf.ty })) { ok = false; break; }
        }
        if (ok && t2.e - base.e > bestGain) { bestGain = t2.e - base.e; cand = t2; }
      }
      if (cand) lifts.push({ bx: base.x, by: base.y, tx: cand.x, ty: cand.y, phase: Math.random() });
    }
  }

  /* streams trace the steepest descent (with a meander), like real water */
  function traceStream(sx, sy) {
    if (inCourse(sx, sy) || inLetters(sx, sy)) return null;   // never start in a course / the words
    var pts = [{ x: sx, y: sy }], x = sx, y = sy;
    for (var s = 0; s < 170; s++) {
      var g = grad(x, y), gm = Math.hypot(g[0], g[1]);
      if (gm < 6e-5) break;
      var dx = -g[0] / gm, dy = -g[1] / gm, px = -dy, py = dx, w = Math.sin(s * 0.4) * 0.5;
      x += (dx + px * w) * 13; y += (dy + py * w) * 13;
      if (x < -240 || x > W + 240 || y < -240 || y > H + 240) break;   // allow off-screen (it scrolls in)
      if (inCourse(x, y) || inLetters(x, y)) break;           // don't run through a course / the words
      pts.push({ x: x, y: y });
    }
    return pts.length > 7 ? pts : null;
  }
  function buildStreams() {
    streams = [];
    var hi = [];
    for (var y = 120; y < H - 90; y += 46) for (var x = 70; x < W - 70; x += 46) hi.push({ x: x, y: y, e: field(x, y) });
    hi.sort(function (a, b) { return b.e - a.e; });
    var cands = [];
    for (var i = 0; i < hi.length && cands.length < 12; i++) {
      var pk = hi[i];
      if (inCourse(pk.x, pk.y) || inLetters(pk.x, pk.y)) continue;
      var st = traceStream(pk.x, pk.y); if (st) cands.push(st);
    }
    cands.sort(function (a, b) { return b.length - a.length; });   // prefer the longest runs
    for (var c = 0; c < cands.length && streams.length < 2; c++) {
      var sC = cands[c], far = true;
      for (var s2 = 0; s2 < streams.length; s2++) if (Math.hypot(sC[0].x - streams[s2][0].x, sC[0].y - streams[s2][0].y) < 220) far = false;
      if (far) streams.push(sC);
    }
  }
  /* a ski lodge by a lift base (ski mode) + a tent by a river (hike mode) */
  function buildLandmarks() {
    lodge = lifts.length ? { x: lifts[0].bx, y: lifts[0].by } : null;
    tent = null;
    if (streams.length) {
      var S = streams[0], i = Math.min(S.length - 1, 4), a = S[i], b = S[Math.min(S.length - 1, i + 1)];
      var dx = b.x - a.x, dy = b.y - a.y, dl = Math.hypot(dx, dy) || 1;
      tent = { x: a.x + (-dy / dl) * 16, y: a.y + (dx / dl) * 16 };
    }
  }

  /* ---- infinite map: a deadzone camera scrolls the world under the player ---- */
  function cameraFollow() {
    if (!window.__topo.renderAt) { clampWalls(); return; }      // fallback if topo can't scroll
    var loX = W * 0.18, hiX = W * 0.82, loY = H * 0.22, hiY = H * 0.80, sdx = 0, sdy = 0;
    if (chr.x < loX) { sdx = chr.x - loX; chr.x = loX; }
    else if (chr.x > hiX) { sdx = chr.x - hiX; chr.x = hiX; }
    if (chr.y < loY) { sdy = chr.y - loY; chr.y = loY; }
    else if (chr.y > hiY) { sdy = chr.y - hiY; chr.y = hiY; }
    if (sdx || sdy) {
      cam.x += sdx; cam.y += sdy;
      shiftWorld(-sdx, -sdy);
      scrollDir.x = scrollDir.x * 0.86 + sdx * 0.14;
      scrollDir.y = scrollDir.y * 0.86 + sdy * 0.14;
      window.__topo.renderAt(base.x + cam.x, base.y + cam.y);
      refreshShade();
    } else { scrollDir.x *= 0.93; scrollDir.y *= 0.93; }
    manageWorld();
  }

  /* move every placed object opposite the scroll, so they stay fixed to the terrain */
  function shiftWorld(dx, dy) {
    var i, j;
    for (i = 0; i < trees.length; i++) { trees[i].x += dx; trees[i].y += dy; }
    for (i = 0; i < peaks.length; i++) { peaks[i].x += dx; peaks[i].y += dy; }
    for (i = 0; i < jumps.length; i++) { jumps[i].x += dx; jumps[i].y += dy; }
    if (jumpZone) { jumpZone.x += dx; jumpZone.y += dy; }
    for (i = 0; i < gates.length; i++) { var g = gates[i]; g.cx += dx; g.cy += dy; g.prev -= dx * g.nx + dy * g.ny; }
    if (slalomZone) { slalomZone.x += dx; slalomZone.y += dy; }
    for (i = 0; i < lifts.length; i++) { var L = lifts[i]; L.bx += dx; L.by += dy; L.tx += dx; L.ty += dy; }
    for (i = 0; i < streams.length; i++) for (j = 0; j < streams[i].length; j++) { streams[i][j].x += dx; streams[i][j].y += dy; }
    for (i = 0; i < trail.length; i++) { trail[i].x += dx; trail[i].y += dy; }
    for (i = 0; i < spray.length; i++) { spray[i].x += dx; spray[i].y += dy; }
    for (i = 0; i < confetti.length; i++) { confetti[i].x += dx; confetti[i].y += dy; }
  }

  function offPt(x, y, m) { return x < -m || x > W + m || y < -m || y > H + m; }
  function offRect(z, m) { return !z || z.x + z.w < -m || z.x > W + m || z.y + z.h < -m || z.y > H + m; }
  function streamOff(S) { for (var i = 0; i < S.length; i++) if (!offPt(S[i].x, S[i].y, 150)) return false; return true; }
  function ringPoint(m) {                                       // a random point just off-screen
    var x, y;
    if (Math.random() < 0.5) { x = Math.random() * (W + 2 * m) - m; y = Math.random() < 0.5 ? -10 - Math.random() * m : H + 10 + Math.random() * m; }
    else { y = Math.random() * (H + 2 * m) - m; x = Math.random() < 0.5 ? -10 - Math.random() * m : W + 10 + Math.random() * m; }
    return { x: x, y: y };
  }
  function leadPoint(dist) {                                    // off-screen, in the direction of travel
    var dx = scrollDir.x, dy = scrollDir.y, m = Math.hypot(dx, dy);
    if (m < 0.5) { var a = Math.random() * 6.2832; dx = Math.cos(a); dy = Math.sin(a); } else { dx /= m; dy /= m; }
    return { x: W / 2 + dx * dist + -dy * (Math.random() - 0.5) * W * 0.5, y: H / 2 + dy * dist + dx * (Math.random() - 0.5) * H * 0.5 };
  }
  function findStart(wantDown) {                                // a sloped (downhill) start near the lead point
    var lp = leadPoint(Math.max(W, H) * 0.6), best = null;
    for (var t = 0; t < 130; t++) {
      var x = lp.x + (Math.random() * 2 - 1) * 280, y = lp.y + (Math.random() * 2 - 1) * 280;
      var g = grad(x, y), gm = Math.hypot(g[0], g[1]);
      if (gm < 0.03 || gm > 0.14) continue;
      if (wantDown && -g[1] / gm < 0.12) continue;
      var sc = gm + (wantDown ? -g[1] / gm * 0.4 : 0);
      if (!best || sc > best.sc) best = { x: x, y: y, sc: sc };
    }
    return best;                                                // null -> caller waits for sloped ground
  }
  function spawnAhead() {                                       // a point off-screen in the direction of travel
    var dx = scrollDir.x, dy = scrollDir.y, mag = Math.hypot(dx, dy);
    if (mag < 0.6) return ringPoint(120);
    dx /= mag; dy /= mag;
    var D = Math.max(W, H), perpx = -dy, perpy = dx, ahead = D * 0.5 + Math.random() * D * 0.3, spread = (Math.random() - 0.5) * D;
    return { x: W / 2 + dx * ahead + perpx * spread, y: H / 2 + dy * ahead + perpy * spread };
  }
  /* keep ~3 summit flags fixed to the terrain (they shift with the world); add a fresh
     one only when the count drops, so they never jump around mid-scroll */
  function managePeaks() {
    for (var i = peaks.length - 1; i >= 0; i--) if (offPt(peaks[i].x, peaks[i].y, 50)) peaks.splice(i, 1);
    if (peaks.length >= 3) return;
    var step = 44, best = null;
    for (var y = 60; y < H - 50; y += step) for (var x = 60; x < W - 50; x += step) {
      var e = field(x, y), isMax = true;
      for (var oy = -1; oy <= 1 && isMax; oy++) for (var ox = -1; ox <= 1; ox++) if ((ox || oy) && field(x + ox * step, y + oy * step) > e) { isMax = false; break; }
      if (!isMax) continue;
      var near = false;
      for (var p = 0; p < peaks.length; p++) if (Math.hypot(x - peaks[p].x, y - peaks[p].y) < 150) { near = true; break; }
      if (!near && (!best || e > best.e)) best = { x: x, y: y, e: e };
    }
    if (best) peaks.push(best);
  }

  /* cull what scrolled away and replenish ahead — keeps exactly one of each course */
  function manageWorld() {
    var M = 130, i;
    for (i = trees.length - 1; i >= 0; i--) if (offPt(trees[i].x, trees[i].y, M)) trees.splice(i, 1);
    var g1 = 0;
    while (trees.length < TREE_POOL && g1++ < 50) { var rp = spawnAhead(); if (inCourse(rp.x, rp.y)) continue; trees.push({ x: rp.x, y: rp.y, size: 9 + Math.random() * 8, born: -1e9 }); }
    managePeaks();
    if (!jumps.length || offRect(jumpZone, 150)) { var ja = findStart(false); if (ja) makeJumpCourse(ja.x, ja.y); }
    if (!gates.length || offRect(slalomZone, 150)) { var sa = findStart(true); if (sa) makeSlalomCourse(sa.x, sa.y); }
    if (mode() === "ski") {
      for (i = lifts.length - 1; i >= 0; i--) { var L = lifts[i]; if (offPt(L.bx, L.by, 150) && offPt(L.tx, L.ty, 150)) lifts.splice(i, 1); }
      var g2 = 0; while (lifts.length < 2 && g2++ < 24) { if (!spawnOneLift()) break; }
      if (streams.length) streams = [];
    } else {
      for (i = streams.length - 1; i >= 0; i--) if (streamOff(streams[i])) streams.splice(i, 1);
      var g3 = 0; while (streams.length < 2 && g3++ < 18) { if (!spawnOneStream()) break; }
      if (lifts.length) lifts = [];
    }
    lodge = lifts.length ? { x: lifts[0].bx, y: lifts[0].by } : null;
    tent = null;
    if (streams.length) { var S = streams[0], k = Math.min(S.length - 1, 4), a = S[k], b = S[Math.min(S.length - 1, k + 1)], dl = Math.hypot(b.x - a.x, b.y - a.y) || 1; tent = { x: a.x + -(b.y - a.y) / dl * 16, y: a.y + (b.x - a.x) / dl * 16 }; }
  }
  function spawnOneLift() {
    var lp = leadPoint(Math.max(W, H) * 0.55), base2 = null, top2 = null, lo = 1e9, hiE = -1e9;
    for (var t = 0; t < 50; t++) { var x = lp.x + (Math.random() * 2 - 1) * 220, y = lp.y + (Math.random() * 2 - 1) * 220, e = field(x, y); if (e < lo) { lo = e; base2 = { x: x, y: y }; } if (e > hiE) { hiE = e; top2 = { x: x, y: y }; } }
    if (!base2 || !top2) return false;
    var d = Math.hypot(top2.x - base2.x, top2.y - base2.y);
    if (d < LIFT_MIN || d > LIFT_MAX || hiE - lo <= 0 || inCourse(base2.x, base2.y) || inCourse(top2.x, top2.y)) return false;
    lifts.push({ bx: base2.x, by: base2.y, tx: top2.x, ty: top2.y, phase: Math.random() });
    return true;
  }
  function spawnOneStream() {
    var lp = leadPoint(Math.max(W, H) * 0.55), start = null, hiE = -1e9;
    for (var t = 0; t < 36; t++) { var x = lp.x + (Math.random() * 2 - 1) * 200, y = lp.y + (Math.random() * 2 - 1) * 200, e = field(x, y); if (e > hiE) { hiE = e; start = { x: x, y: y }; } }
    if (!start || inCourse(start.x, start.y)) return false;
    var st = traceStream(start.x, start.y);
    if (st) { streams.push(st); return true; }
    return false;
  }

  function buildSnow() {
    snow = [];
    for (var i = 0; i < N_SNOW; i++) snow.push({ x: Math.random() * W, y: Math.random() * H, r: 0.6 + Math.random() * 1.5, vy: 0.25 + Math.random() * 0.6, sw: Math.random() * 6.28 });
  }

  /* relief shading: recomputed from the current (scrolling) terrain into a reused buffer */
  function refreshShade() {
    var sw = Math.max(1, Math.ceil(W / shadeSc)), sh = Math.max(1, Math.ceil(H / shadeSc));
    if (!shadeCanvas || shadeW !== sw || shadeH !== sh) {
      shadeCanvas = document.createElement("canvas"); shadeCanvas.width = sw; shadeCanvas.height = sh;
      shadeCtx = shadeCanvas.getContext("2d"); shadeImg = shadeCtx.createImageData(sw, sh);
      shadeVals = new Float32Array(sw * sh); shadeW = sw; shadeH = sh;
    }
    var sc = shadeSc, data = shadeImg.data, vals = shadeVals, mn = 1e9, mx = -1e9, k = 0;
    for (var j = 0; j < sh; j++) for (var i = 0; i < sw; i++) { var e = field(i * sc, j * sc); vals[k++] = e; if (e < mn) mn = e; if (e > mx) mx = e; }
    var rng = (mx - mn) || 1, ski = mode() === "ski", fg = hexRgb(C.fg);
    for (var p = 0, q = 0; q < vals.length; q++, p += 4) {
      var e2 = (vals[q] - mn) / rng, a, r, gg, b;
      if (ski) { a = (1 - e2) * (1 - e2) * 0.22; r = 24; gg = 14; b = 6; }
      else { a = e2 * e2 * 0.14; r = fg[0]; gg = fg[1]; b = fg[2]; }
      data[p] = r; data[p + 1] = gg; data[p + 2] = b; data[p + 3] = Math.round(a * 255);
    }
    shadeCtx.putImageData(shadeImg, 0, 0);
    shade = shadeCanvas;
  }

  function clampWalls() {
    if (chr.x < 16) { chr.x = 16; chr.vx *= -0.3; }
    if (chr.x > W - 16) { chr.x = W - 16; chr.vx *= -0.3; }
    if (chr.y < TOP_MARGIN) { chr.y = TOP_MARGIN; chr.vy *= -0.3; }
    if (chr.y > H - 22) { chr.y = H - 22; chr.vy *= -0.3; }
  }
  function flash(t) { chr.flash = t; chr.flashT = 80; }

  /* ---- physics ---- */
  function step() {
    if (chr.liftCool > 0) chr.liftCool--;
    if (chr.airCool > 0) chr.airCool--;
    if (chr.treeCool > 0) chr.treeCool--;
    if (chr.flashT > 0) chr.flashT--;

    var rawx, rawy;
    if (locked) { rawx = pendingX; rawy = pendingY; pendingX = pendingY = 0; }
    else { rawx = (freeMouse.x - chr.x) * 0.16; rawy = (freeMouse.y - chr.y) * 0.16; }
    smInX += (rawx - smInX) * SMOOTH;
    smInY += (rawy - smInY) * SMOOTH;
    var vInx = smInX * SENS, vIny = smInY * SENS, inputMag = Math.hypot(vInx, vIny);

    if (chr.air > 0) return stepAir();
    if (chr.onLift) return stepLift();
    if (chr.inStream) return stepStream(inputMag);

    var g = grad(chr.x, chr.y);
    var gm = Math.hypot(g[0], g[1]);
    var gux = gm > 1e-6 ? g[0] / gm : 0, guy = gm > 1e-6 ? g[1] / gm : 0;

    if (chr.wipe > 0) return stepWipe(gux, guy, gm);

    var along = vInx * gux + vIny * guy;                   // >0 = pushing uphill
    if (gm > 1e-6) {
      var crossx = vInx - along * gux, crossy = vIny - along * guy;
      var aFac = along > 0 ? Math.max(CLIMB_MIN, 1 - CLIMB_K * gm) : DOWN_FACTOR;
      var alongR = along * aFac;
      vInx = crossx + alongR * gux; vIny = crossy + alongR * guy;
    }

    /* DIRECTIONAL footing: grip while idle / climbing / on a top, release downhill.
       Climbing keeps its grip up to a higher speed, so reaching the peaks isn't a slog. */
    var climbing = along > 0;
    var notDown = along >= 0 ? 1 : Math.max(0, 1 - (-along) / DOWN_RELEASE);
    var speedFac = climbing ? Math.max(0.55, 1 - chr.speed / CLIMB_GRIP) : Math.max(0, 1 - chr.speed / GRIP_SPEED);
    var grip = notDown * speedFac;
    var gEff = Math.max(0, GRAV * gm - GRIP * grip);
    var vGx = -gux * gEff, vGy = -guy * gEff;

    var tx = vInx + vGx, ty = vIny + vGy;
    chr.vx += (tx - chr.vx) * RESPONSE;
    chr.vy += (ty - chr.vy) * RESPONSE;
    if (grip > 0.5 && inputMag < 0.6) { chr.vx *= STOP_DAMP; chr.vy *= STOP_DAMP; }
    var sp = Math.hypot(chr.vx, chr.vy);
    if (sp > MAXSPEED) { chr.vx = chr.vx / sp * MAXSPEED; chr.vy = chr.vy / sp * MAXSPEED; sp = MAXSPEED; }
    chr.speed = sp;

    var px = chr.x, py = chr.y;
    chr.x += chr.vx; chr.y += chr.vy;

    var moved = Math.hypot(chr.x - px, chr.y - py);
    if (sp > 0.4) {
      var d = Math.atan2(chr.vy, chr.vx) - chr.ang;
      while (d > Math.PI) d -= 6.2832; while (d < -Math.PI) d += 6.2832;
      chr.ang += d * 0.25;
    }
    var vDown = chr.vx * -gux + chr.vy * -guy;
    chr.sliding = vDown > SLIDE_THRESH && sp > SLIDE_THRESH;
    chr.walk += moved * 0.55;
    if (vDown > 0.5) score += vDown * SCORE_RATE;
    if (chr.sliding && sp > 4) spawnSpray();
    if (moved > 3) { trail.push({ x: chr.x, y: chr.y }); if (trail.length > 70) trail.shift(); }

    checkJumps();
    checkSlalom();
    if (mode() === "hike") checkStreamEntry();
    if (mode() === "ski") checkLifts();
    checkTrees();
  }

  function stepWipe(gux, guy, gm) {
    chr.wipe--;
    var wgx = -gux * GRAV * gm, wgy = -guy * GRAV * gm;
    chr.vx += (wgx - chr.vx) * 0.15; chr.vy += (wgy - chr.vy) * 0.15;
    chr.vx *= 0.9; chr.vy *= 0.9;
    chr.tumble += chr.spin; chr.spin *= 0.92;
    chr.x += chr.vx; chr.y += chr.vy;
    chr.speed = Math.hypot(chr.vx, chr.vy); chr.sliding = false;
    if (chr.wipe <= 0) { chr.spin = 0; chr.tumble = 0; }
  }

  function stepLift() {
    var L = chr.onLift, len = Math.hypot(L.tx - L.bx, L.ty - L.by) || 1;
    chr.lt += LIFT_SPEED / len;
    var tt = chr.lt < 1 ? chr.lt : 1;
    chr.x = L.bx + (L.tx - L.bx) * tt; chr.y = L.by + (L.ty - L.by) * tt;
    chr.vx = chr.vy = 0; chr.speed = 0; chr.sliding = false; chr.walk += 0.12;
    var la = Math.atan2(L.ty - L.by, L.tx - L.bx);
    chr.ang += ((la - chr.ang + 9.4248) % 6.2832 - 3.1416) * 0.2;
    if (tt >= 1) { chr.onLift = null; chr.liftCool = 70; }
  }

  function stepStream(inputMag) {
    var S = chr.inStream;
    if (inputMag > STREAM_EXIT) { chr.inStream = null; chr.vx = smInX * SENS; chr.vy = smInY * SENS; return; }
    chr.streamF += STREAM_SPEED / 12;
    var idx = Math.floor(chr.streamF);
    if (idx >= S.length - 1) { chr.inStream = null; return; }
    var t = chr.streamF - idx, a = S[idx], b = S[idx + 1];
    chr.x = a.x + (b.x - a.x) * t; chr.y = a.y + (b.y - a.y) * t;
    var la = Math.atan2(b.y - a.y, b.x - a.x);
    chr.ang += ((la - chr.ang + 9.4248) % 6.2832 - 3.1416) * 0.25;
    chr.bob += 0.34; chr.speed = STREAM_SPEED; chr.sliding = false;
    score += STREAM_SPEED * SCORE_RATE * 0.7;
    if (Math.random() < 0.35) {
      var ang = chr.ang + (Math.random() - 0.5) * 2.4, s = 0.5 + Math.random();
      spray.push({ x: chr.x, y: chr.y, vx: Math.cos(ang) * s, vy: Math.sin(ang) * s, life: 1, water: true });
    }
  }

  function stepAir() {
    chr.air--;
    var p = 1 - chr.air / chr.airMax;
    chr.airH = Math.sin(p * Math.PI);
    chr.x += chr.avx; chr.y += chr.avy; chr.avx *= 0.995; chr.avy *= 0.995;
    chr.tumble += chr.trickSpin; chr.trickSpin *= 0.95;
    chr.flip += chr.flipV; chr.flipV *= 0.97;
    chr.speed = Math.hypot(chr.avx, chr.avy);
    if (chr.air <= 0) {
      chr.airH = 0; chr.tumble = 0; chr.trickSpin = 0; chr.flip = 0; chr.flipV = 0;
      chr.vx = chr.avx; chr.vy = chr.avy;
      if (chr.trickPts > 0) { score += chr.trickPts; flash("TRICK +" + chr.trickPts); }
      chr.trickPts = 0; chr.trick = 0; chr.airCool = 12;
    }
  }
  function doSpin() {                                    // click in the air -> 360 spin
    if (chr.air <= 0 || chr.trick >= 4) return;
    chr.trickSpin += (chr.avx >= 0 ? 1 : -1) * 0.42; chr.trick++; chr.trickPts += TRICK_PTS;
  }
  function doFlip() {                                    // space in the air -> backflip
    if (chr.air <= 0 || chr.trick >= 4) return;
    chr.flipV += 0.5; chr.trick++; chr.trickPts += TRICK_PTS;
  }

  function checkJumps() {
    if (chr.airCool > 0) return;
    for (var i = 0; i < jumps.length; i++) {
      var j = jumps[i];
      if (chr.speed > JUMP_MIN_SP && Math.hypot(chr.x - j.x, chr.y - j.y) < JUMP_R) {
        chr.air = chr.airMax = AIR_TIME; chr.airH = 0; chr.avx = chr.vx * 1.18; chr.avy = chr.vy * 1.18;
        chr.trick = chr.trickPts = chr.trickSpin = chr.flip = chr.flipV = 0; flash("JUMP! space=flip · click=spin"); break;
      }
    }
  }

  function checkSlalom() {
    if (!gates.length) return;
    var trail = mode() === "hike", passedCount = 0;
    for (var i = 0; i < gates.length; i++) {
      var ga = gates[i];
      if (trail) {                                        // hiking: follow the trail, pass each cairn
        if (!ga.passed && Math.hypot(chr.x - ga.cx, chr.y - ga.cy) < ga.hw + 12) {
          ga.passed = true; chr.combo++; score += 40 + chr.combo * 15; flash("MARKER x" + chr.combo);
        }
      } else {                                            // skiing: thread between the poles
        var side = (chr.x - ga.cx) * ga.nx + (chr.y - ga.cy) * ga.ny;   // signed distance along the fall line
        var p1x = ga.cx + ga.px * ga.hw, p1y = ga.cy + ga.py * ga.hw, p2x = ga.cx - ga.px * ga.hw, p2y = ga.cy - ga.py * ga.hw;
        if (Math.hypot(chr.x - p1x, chr.y - p1y) < 6 || Math.hypot(chr.x - p2x, chr.y - p2y) < 6) {
          gateBump(ga);
        } else if (!ga.passed && ga.prev < 0 && side >= 0) {
          var lat = Math.abs((chr.x - ga.cx) * ga.px + (chr.y - ga.cy) * ga.py);
          if (lat < ga.hw) { ga.passed = true; chr.combo++; score += 40 + chr.combo * 15; flash("GATE x" + chr.combo); }
          else chr.combo = 0;
        }
        ga.prev = side;
      }
      if (ga.passed) passedCount++;
    }
    if (!slalomCleared && passedCount === gates.length) { slalomCleared = true; celebrateSlalom(); }
  }
  /* clipping a gate pole is a gentle nudge + lost combo, not a full wipeout */
  function gateBump(ga) {
    var latv = (chr.x - ga.cx) * ga.px + (chr.y - ga.cy) * ga.py, dir = latv < 0 ? -1 : 1;
    chr.x = ga.cx + ga.px * dir * (ga.hw + 4); chr.y = ga.cy + ga.py * dir * (ga.hw + 4);
    chr.vx = chr.vx * 0.5 + ga.px * dir * 1.4; chr.vy = chr.vy * 0.5 + ga.py * dir * 1.4;
    if (chr.combo > 0) flash("MISSED GATE");
    chr.combo = 0;
  }
  function celebrateSlalom() {
    var bonus = 200 + chr.combo * 20;
    score += bonus; flash((mode() === "hike" ? "✦ TRAIL DONE +" : "✦ SLALOM CLEAR +") + bonus);
    for (var i = 0; i < 46; i++) {
      var a = Math.random() * 6.2832, sp = 1.4 + Math.random() * 3.6;
      confetti.push({ x: chr.x, y: chr.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.6, life: 1, c: Math.random() < 0.5 ? C.accent : C.fg });
    }
  }
  function updateConfetti() {
    for (var i = confetti.length - 1; i >= 0; i--) {
      var p = confetti[i]; p.x += p.vx; p.y += p.vy; p.vy += 0.09; p.vx *= 0.98; p.life -= 0.016;
      if (p.life <= 0) confetti.splice(i, 1);
    }
  }

  function checkStreamEntry() {
    for (var i = 0; i < streams.length; i++) {
      var S = streams[i];
      for (var k = 0; k < S.length - 2; k += 2) {
        if (Math.hypot(chr.x - S[k].x, chr.y - S[k].y) < 15) { chr.inStream = S; chr.streamF = k; chr.bob = 0; return; }
      }
    }
  }

  function checkLifts() {
    if (chr.liftCool > 0) return;
    for (var j = 0; j < lifts.length; j++) {
      var Lf = lifts[j];
      if (Math.hypot(chr.x - Lf.bx, chr.y - Lf.by) < LIFT_ATTACH) { chr.onLift = Lf; chr.lt = 0; chr.vx = chr.vy = 0; break; }
    }
  }

  function checkTrees() {
    if (chr.treeCool > 0) return;                          // brief grace so you don't get stuck
    var now = performance.now();
    for (var i = 0; i < trees.length; i++) {
      var tr = trees[i]; if (now - tr.born < POP_DUR) continue;
      var ddx = chr.x - tr.x, ddy = chr.y - tr.y, dd = Math.hypot(ddx, ddy), rr = tr.size * 0.5 + 6;
      if (dd < rr) { wipeout(ddx, ddy, dd, rr); break; }
    }
  }

  function wipeout(dx, dy, d, rr) {
    chr.wipe = WIPE_TIME;
    var nx = d > 1e-3 ? dx / d : 0, ny = d > 1e-3 ? dy / d : 1;
    chr.x = (chr.x - dx) + nx * (rr + 6); chr.y = (chr.y - dy) + ny * (rr + 6);     // shove well clear
    var dot = chr.vx * nx + chr.vy * ny;
    chr.vx = (chr.vx - 2 * dot * nx) * 0.5 + nx * 4.4;     // reflect + a real bounce off the trunk
    chr.vy = (chr.vy - 2 * dot * ny) * 0.5 + ny * 4.4;
    chr.spin = (Math.random() < 0.5 ? -1 : 1) * 0.55;
    chr.treeCool = WIPE_TIME + 18;
    score = Math.max(0, score - 25);
    for (var s = 0; s < 16; s++) {
      var a = Math.random() * 6.2832, sp = 1 + Math.random() * 2.6;
      spray.push({ x: chr.x, y: chr.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1 });
    }
  }

  /* ---- spray / snow ---- */
  function spawnSpray() {
    var bx = chr.x - Math.cos(chr.ang) * 7, by = chr.y - Math.sin(chr.ang) * 7;
    for (var k = 0; k < 2; k++) {
      var a = chr.ang + Math.PI + (Math.random() - 0.5) * 1.1, s = 0.6 + Math.random() * 1.7;
      spray.push({ x: bx, y: by, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1 });
    }
    while (spray.length > 110) spray.shift();
  }
  function updateSpray() {
    for (var i = spray.length - 1; i >= 0; i--) {
      var p = spray[i]; p.x += p.vx; p.y += p.vy; p.vx *= 0.9; p.vy *= 0.9; p.life -= 0.05;
      if (p.life <= 0) spray.splice(i, 1);
    }
  }
  function drawSpray() {
    var ski = mode() === "ski";
    for (var i = 0; i < spray.length; i++) {
      var p = spray[i];
      ctx.fillStyle = p.water ? WATER_HI : (ski ? C.fg : C.soft);
      ctx.globalAlpha = Math.max(0, p.life) * (ski ? 0.7 : 0.5);
      ctx.beginPath(); ctx.arc(p.x, p.y, ski ? 1.7 : 1.4, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function updateSnow() {
    for (var i = 0; i < snow.length; i++) {
      var p = snow[i]; p.sw += 0.02; p.y += p.vy; p.x += Math.sin(p.sw) * 0.3;
      if (p.y > H + 4) { p.y = -4; p.x = Math.random() * W; }
    }
  }
  function drawSnow() {
    if (mode() !== "ski") return;
    ctx.fillStyle = C.fg;
    for (var i = 0; i < snow.length; i++) {
      var p = snow[i]; ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* ---- aim ---- */
  function updateAim() {
    var el = document.elementFromPoint(chr.x, chr.y);
    var target = el && el.closest ? el.closest("a.menu__item, .theme-toggle, .dock__icon") : null;
    if (target !== aimEl) {
      if (aimEl) aimEl.classList.remove("is-aim");
      aimEl = target;
      if (aimEl) aimEl.classList.add("is-aim");
    }
  }
  function clearAim() { if (aimEl) { aimEl.classList.remove("is-aim"); aimEl = null; } }

  /* ---- rendering (top-down map view) ---- */
  function easeOutBack(p) { var c1 = 1.70158, c3 = c1 + 1, u = p - 1; return 1 + c3 * u * u * u + c1 * u * u; }
  function roundRectPath(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function drawShade() {
    if (!shade) return;
    ctx.imageSmoothingEnabled = true; ctx.globalAlpha = 1;
    ctx.drawImage(shade, 0, 0, W, H);
  }

  function drawStreams(now) {
    if (mode() !== "hike") return;
    for (var i = 0; i < streams.length; i++) {
      var S = streams[i];
      ctx.strokeStyle = WATER; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.globalAlpha = 0.6; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(S[0].x, S[0].y); for (var k = 1; k < S.length; k++) ctx.lineTo(S[k].x, S[k].y); ctx.stroke();
      ctx.globalAlpha = 0.55; ctx.strokeStyle = WATER_HI; ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 7]); ctx.lineDashOffset = -(now * 0.03 % 11);
      ctx.beginPath(); ctx.moveTo(S[0].x, S[0].y); for (var k2 = 1; k2 < S.length; k2++) ctx.lineTo(S[k2].x, S[k2].y); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }

  function drawZones() {
    ctx.save(); ctx.setLineDash([5, 6]); ctx.lineWidth = 1; ctx.globalAlpha = 0.45; ctx.strokeStyle = C.soft;
    ctx.font = "9px " + FONT; ctx.fillStyle = C.soft;
    if (jumpZone) { roundRectPath(jumpZone.x, jumpZone.y, jumpZone.w, jumpZone.h, 12); ctx.stroke(); ctx.globalAlpha = 0.6; ctx.fillText("JUMPS", jumpZone.x + 7, jumpZone.y + 13); ctx.globalAlpha = 0.45; }
    if (slalomZone) { roundRectPath(slalomZone.x, slalomZone.y, slalomZone.w, slalomZone.h, 12); ctx.stroke(); ctx.globalAlpha = 0.6; ctx.fillText(mode() === "hike" ? "TRAIL" : "SLALOM", slalomZone.x + 7, slalomZone.y + 13); }
    ctx.restore();
  }

  function drawJumps() {
    /* a little flagged banner across the top of the park */
    if (jumpZone) {
      var bx = jumpZone.x + 8, bx2 = jumpZone.x + jumpZone.w - 8, by = jumpZone.y + 7;
      ctx.globalAlpha = 0.5; ctx.strokeStyle = C.soft; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx2, by); ctx.stroke();
      ctx.fillStyle = C.accent; ctx.globalAlpha = 0.7;
      for (var f = bx + 5; f < bx2 - 5; f += 15) { ctx.beginPath(); ctx.moveTo(f, by); ctx.lineTo(f + 6, by); ctx.lineTo(f + 3, by + 5); ctx.closePath(); ctx.fill(); }
    }
    for (var i = 0; i < jumps.length; i++) {
      var j = jumps[i], a = Math.atan2(j.dy, j.dx);
      ctx.save(); ctx.translate(j.x, j.y); ctx.rotate(a);
      /* wider kicker with a shaded takeoff face */
      ctx.globalAlpha = 0.9; ctx.fillStyle = "#5b4636";
      ctx.beginPath(); ctx.moveTo(-13, 8); ctx.lineTo(14, 0); ctx.lineTo(-13, -8); ctx.closePath(); ctx.fill();
      ctx.fillStyle = C.soft; ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.moveTo(-13, 8); ctx.lineTo(14, 0); ctx.lineTo(2, 3.5); ctx.closePath(); ctx.fill();
      /* bright takeoff lip + side posts */
      ctx.strokeStyle = C.accent; ctx.lineWidth = 2.6; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(14, -7); ctx.lineTo(14, 7); ctx.stroke();
      ctx.fillStyle = C.fg; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.arc(-13, 8, 1.5, 0, 6.2832); ctx.fill();
      ctx.beginPath(); ctx.arc(-13, -8, 1.5, 0, 6.2832); ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawSlalom() {
    var trail = mode() === "hike";
    for (var i = 0; i < gates.length; i++) {
      var ga = gates[i];
      if (trail) { drawCairn(ga.cx, ga.cy, ga.passed); continue; }   // hiking: trail cairns
      var p1x = ga.cx + ga.px * ga.hw, p1y = ga.cy + ga.py * ga.hw;  // skiing: a pair of poles
      var p2x = ga.cx - ga.px * ga.hw, p2y = ga.cy - ga.py * ga.hw;
      ctx.globalAlpha = ga.passed ? 0.8 : 0.45; ctx.strokeStyle = C.soft; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p1x, p1y); ctx.lineTo(p2x, p2y); ctx.stroke();
      gatePole(p1x, p1y, ga.passed); gatePole(p2x, p2y, ga.passed);
    }
    ctx.globalAlpha = 1;
  }
  function drawCairn(x, y, passed) {
    ctx.globalAlpha = passed ? 0.95 : 0.7; ctx.fillStyle = C.soft;
    ctx.beginPath(); ctx.ellipse(x, y + 2.6, 4.4, 2, 0, 0, 6.2832); ctx.fill();   // base stones
    ctx.beginPath(); ctx.arc(x, y, 2.9, 0, 6.2832); ctx.fill();
    ctx.beginPath(); ctx.arc(x - 0.4, y - 3.3, 1.9, 0, 6.2832); ctx.fill();        // top stone
    if (passed) { ctx.fillStyle = C.accent; ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.arc(x, y - 5.6, 1.3, 0, 6.2832); ctx.fill(); }
    ctx.globalAlpha = 1;
  }
  function gatePole(x, y, passed) {
    ctx.fillStyle = passed ? C.accent : C.fg; ctx.globalAlpha = passed ? 0.9 : 0.7;
    ctx.beginPath(); ctx.arc(x, y, 2, 0, 6.2832); ctx.fill();
    ctx.fillStyle = C.accent; ctx.globalAlpha = passed ? 0.9 : 0.55;
    ctx.beginPath(); ctx.moveTo(x, y - 1); ctx.lineTo(x + 5, y - 3); ctx.lineTo(x, y - 5); ctx.closePath(); ctx.fill();
  }

  function drawPeaks() {
    for (var i = 0; i < peaks.length; i++) {
      var p = peaks[i];
      ctx.globalAlpha = 0.85; ctx.strokeStyle = C.fg; ctx.lineWidth = 1.3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y - 11); ctx.stroke();
      ctx.fillStyle = C.accent; ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.moveTo(p.x, p.y - 11); ctx.lineTo(p.x + 8, p.y - 8.5); ctx.lineTo(p.x, p.y - 6); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 0.5; ctx.fillStyle = C.fg;
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.6, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawLifts(now) {
    if (mode() !== "ski") return;                  // lifts are a ski-mode thing
    for (var i = 0; i < lifts.length; i++) {
      var L = lifts[i], len = Math.hypot(L.tx - L.bx, L.ty - L.by) || 1;
      var ux = (L.tx - L.bx) / len, uy = (L.ty - L.by) / len, nx = -uy, ny = ux;
      ctx.globalAlpha = 0.6; ctx.strokeStyle = C.soft; ctx.lineWidth = 1.1; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(L.bx, L.by); ctx.lineTo(L.tx, L.ty); ctx.stroke();
      for (var s = 0.22; s < 0.92; s += 0.3) {
        var txp = L.bx + ux * len * s, typ = L.by + uy * len * s;
        ctx.beginPath(); ctx.moveTo(txp - nx * 3, typ - ny * 3); ctx.lineTo(txp + nx * 3, typ + ny * 3); ctx.stroke();
      }
      ctx.fillStyle = C.fg; ctx.globalAlpha = 0.85;
      for (var c = 0; c < 3; c++) {
        var f = (now * 0.00005 + L.phase + c / 3) % 1, cx = L.bx + ux * len * f, cy = L.by + uy * len * f;
        ctx.fillRect(cx - 1.5 + nx * 2, cy - 1.5 + ny * 2, 3, 3);
      }
      ctx.globalAlpha = 0.95; ctx.fillStyle = C.accent;
      ctx.beginPath(); ctx.arc(L.bx, L.by, 3.2, 0, 6.2832); ctx.fill();
      ctx.beginPath(); ctx.arc(L.tx, L.ty, 3.2, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawLodge() {
    if (mode() !== "ski" || !lodge) return;
    var x = lodge.x, y = lodge.y;
    ctx.globalAlpha = 0.18; ctx.fillStyle = C.fg; ctx.beginPath(); ctx.ellipse(x + 1, y + 5, 11, 4, 0, 0, 6.2832); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = "#5b4636"; roundRectPath(x - 9, y - 5, 18, 11, 2); ctx.fill();
    ctx.fillStyle = C.accent; ctx.globalAlpha = 0.9; roundRectPath(x - 10, y - 7, 20, 5, 2); ctx.fill();
    ctx.globalAlpha = 0.5; ctx.strokeStyle = C.fg; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - 8, y - 1); ctx.lineTo(x + 8, y - 1); ctx.stroke();
    ctx.globalAlpha = 0.9; ctx.fillStyle = "#5b4636"; ctx.fillRect(x + 4, y - 10, 2.4, 3.4);
    ctx.globalAlpha = 0.4; ctx.fillStyle = C.fg; ctx.beginPath(); ctx.arc(x + 5.2, y - 12.5, 1.6, 0, 6.2832); ctx.fill();
    ctx.globalAlpha = 1;
  }
  function drawTent() {
    if (mode() !== "hike" || !tent) return;
    var x = tent.x, y = tent.y;
    ctx.globalAlpha = 0.16; ctx.fillStyle = C.fg; ctx.beginPath(); ctx.ellipse(x + 1, y + 4, 9, 3.2, 0, 0, 6.2832); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = C.accent;
    ctx.beginPath(); ctx.moveTo(x - 8, y + 4); ctx.lineTo(x, y - 7); ctx.lineTo(x + 8, y + 4); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 0.55; ctx.strokeStyle = C.fg; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 4); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(x + 12, y + 3, 1.8, 0, 6.2832); ctx.fill();
    ctx.globalAlpha = 0.3; ctx.beginPath(); ctx.arc(x + 12, y + 3, 4, 0, 6.2832); ctx.fill();
    ctx.globalAlpha = 1;
  }
  function drawConfetti() {
    for (var i = 0; i < confetti.length; i++) {
      var p = confetti[i]; ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.c;
      ctx.fillRect(p.x - 1.4, p.y - 1.4, 2.8, 2.8);
    }
    ctx.globalAlpha = 1;
  }

  function drawTrees(now) {
    for (var i = 0; i < trees.length; i++) {
      var tr = trees[i], age = now - tr.born;
      if (age < 0) continue;
      var p = Math.min(1, age / POP_DUR), e = Math.max(0, easeOutBack(p)), a = Math.min(1, p * 1.6);
      var r = tr.size * 0.62 * e, x = tr.x, y = tr.y;
      ctx.globalAlpha = a * 0.16; ctx.fillStyle = C.fg;
      ctx.beginPath(); ctx.arc(x + 1.6, y + 2.2, r * 0.92, 0, 6.2832); ctx.fill();
      ctx.globalAlpha = a; ctx.fillStyle = TREE_DK;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
      ctx.fillStyle = TREE_TOP;
      ctx.beginPath(); ctx.arc(x - r * 0.16, y - r * 0.2, r * 0.6, 0, 6.2832); ctx.fill();
      ctx.fillStyle = TREE_DK;
      ctx.beginPath(); ctx.arc(x - r * 0.16, y - r * 0.2, r * 0.16, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawTrail() {
    if (trail.length < 2) return;
    if (mode() === "ski") {
      ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = C.accent;
      for (var i = 1; i < trail.length; i++) {
        ctx.globalAlpha = (i / trail.length) * 0.45; ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.moveTo(trail[i - 1].x, trail[i - 1].y); ctx.lineTo(trail[i].x, trail[i].y); ctx.stroke();
      }
    } else {
      ctx.fillStyle = C.soft;
      for (var j = 0; j < trail.length; j += 2) {
        ctx.globalAlpha = (j / trail.length) * 0.4;
        ctx.beginPath(); ctx.arc(trail[j].x, trail[j].y, 1.5, 0, 6.2832); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawSpeedLines() {
    if (chr.speed < SPEED_LINE_TH || chr.air > 0) return;
    var vmag = chr.speed, ux = chr.vx / vmag, uy = chr.vy / vmag, px = -uy, py = ux;
    var len = 8 + (vmag - SPEED_LINE_TH) * 3.4, al = Math.min(0.5, (vmag - SPEED_LINE_TH) * 0.13);
    ctx.strokeStyle = C.fg; ctx.lineCap = "round"; ctx.lineWidth = 1.2; ctx.globalAlpha = al;
    for (var i = 0; i < 4; i++) {
      var off = (i - 1.5) * 6, sx = chr.x - ux * 12 + px * off, sy = chr.y - uy * 12 + py * off;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx - ux * len, sy - uy * len); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawFallLine() {
    if (chr.onLift || chr.inStream || chr.wipe > 0 || chr.air > 0) return;
    var g = grad(chr.x, chr.y), gm = Math.hypot(g[0], g[1]);
    if (gm < 6e-4) return;
    var dx = -g[0] / gm, dy = -g[1] / gm, ang = Math.atan2(dy, dx);
    var s0 = 17, len = 12 + Math.min(20, gm * 110);
    var sx = chr.x + dx * s0, sy = chr.y + dy * s0, ex = chr.x + dx * (s0 + len), ey = chr.y + dy * (s0 + len);
    ctx.globalAlpha = 0.55; ctx.strokeStyle = C.accent; ctx.lineWidth = 1.6; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang - 0.42) * 5, ey - Math.sin(ang - 0.42) * 5);
    ctx.moveTo(ex, ey); ctx.lineTo(ex - Math.cos(ang + 0.42) * 5, ey - Math.sin(ang + 0.42) * 5);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawChar() {
    var lift = 1 + chr.airH * 0.5, bobY = chr.inStream ? Math.sin(chr.bob) * 1.6 : 0;
    ctx.save();
    ctx.translate(chr.x, chr.y + bobY);
    ctx.globalAlpha = 0.16 * (1 - chr.airH * 0.5); ctx.fillStyle = C.fg;
    ctx.beginPath(); ctx.ellipse(0.6, 1.4 + chr.airH * 6, 8 / lift, 6.2 / lift, 0, 0, 6.2832); ctx.fill();
    ctx.globalAlpha = 0.26; ctx.strokeStyle = C.accent; ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, 6.2832); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.translate(0, -chr.airH * 6);
    ctx.scale(lift, lift);
    ctx.rotate(chr.ang + chr.tumble);
    if (chr.flip) ctx.scale(Math.cos(chr.flip), 1);       // backflip: tips over the forward axis
    if (mode() === "ski") drawSkier(); else drawHiker();
    ctx.restore();
  }

  function drawHiker() {
    var walking = !chr.sliding && chr.speed > 0.6;
    var stride = chr.inStream ? Math.sin(chr.bob) * 0.6 : (walking ? Math.sin(chr.walk) : 0);
    ctx.lineCap = "round";
    ctx.fillStyle = C.accent;
    ctx.beginPath(); ctx.ellipse(-2.6, 0, 2.7, 3.4, 0, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = C.fg; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, -3); ctx.lineTo(0.6 - stride * 2.4, -5.1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 3); ctx.lineTo(0.6 + stride * 2.4, 5.1); ctx.stroke();
    ctx.lineWidth = 2.0;
    ctx.beginPath(); ctx.moveTo(0, -1.7); ctx.lineTo(stride * 3.4, -2.7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 1.7); ctx.lineTo(-stride * 3.4, 2.7); ctx.stroke();
    ctx.fillStyle = C.fg;
    ctx.beginPath(); ctx.ellipse(0, 0, 3.0, 4.0, 0, 0, 6.2832); ctx.fill();
    ctx.beginPath(); ctx.arc(2.1, 0, 2.3, 0, 6.2832); ctx.fill();
    ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(2.3, 0, 1.1, 0, 6.2832); ctx.fill();
  }

  function drawSkier() {
    var carve = chr.sliding ? Math.sin(chr.walk * 0.7) * 0.16 : 0;
    var splay = (!chr.sliding && chr.speed > 0.4) ? 0.20 : 0.03;
    drawSki(2.7, carve + splay);
    drawSki(-2.7, carve - splay);
    ctx.strokeStyle = C.accent; ctx.lineWidth = 1.2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(0, -3.3); ctx.lineTo(-4, -5.3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 3.3); ctx.lineTo(-4, 5.3); ctx.stroke();
    ctx.fillStyle = C.accent; ctx.beginPath(); ctx.ellipse(0.4, 0, 3.0, 3.5, 0, 0, 6.2832); ctx.fill();
    ctx.fillStyle = C.fg; ctx.beginPath(); ctx.arc(2.3, 0, 2.2, 0, 6.2832); ctx.fill();
  }
  function drawSki(yoff, ang) {
    ctx.save(); ctx.translate(0, yoff); ctx.rotate(ang);
    ctx.fillStyle = C.fg; roundRectPath(-6, -1.1, 17, 2.2, 1.1); ctx.fill();
    ctx.restore();
  }

  function pad(n) { n = "" + Math.round(n); while (n.length < 4) n = "0" + n; return n; }
  function statusTag() {
    if (chr.flashT > 0) return " &nbsp;·&nbsp; <span>" + chr.flash + "</span>";
    if (chr.air > 0) return " &nbsp;·&nbsp; <span>AIR — space=flip · click=spin</span>";
    if (chr.inStream) return " &nbsp;·&nbsp; <span>~ STREAM</span>";
    if (chr.onLift) return " &nbsp;·&nbsp; <span>▲ LIFT</span>";
    if (chr.wipe > 0) return " &nbsp;·&nbsp; <span>WIPEOUT</span>";
    if (!aimEl) return "";
    var txt = aimEl.querySelector ? aimEl.querySelector(".menu__txt") : null;
    if (txt) return " &nbsp;·&nbsp; <span>↵ " + txt.textContent + "</span>";
    if (aimEl.classList.contains("theme-toggle")) return " &nbsp;·&nbsp; <span>↵ THEME</span>";
    return " &nbsp;·&nbsp; <span>↵ OPEN</span>";
  }

  function loop() {
    raf = active ? requestAnimationFrame(loop) : null;
    if (!active) return;
    var now = performance.now();
    step();
    cameraFollow();
    updateSpray();
    updateSnow();
    updateConfetti();
    updateAim();
    ctx.clearRect(0, 0, W, H);
    drawShade();
    drawStreams(now);
    drawTent();
    drawLifts(now);
    drawLodge();
    drawZones();
    drawSlalom();
    drawJumps();
    drawPeaks();
    drawTrees(now);
    drawTrail();
    drawSpeedLines();
    drawFallLine();
    drawSpray();
    drawConfetti();
    drawChar();
    drawSnow();
    if (score > best) { best = score; try { localStorage.setItem("topoBest", Math.round(best)); } catch (e) {} }
    var alt = Math.round((field(chr.x, chr.y) * 1850 + 540) / 5) * 5;
    hud.innerHTML = "▲ " + alt.toLocaleString() + " M &nbsp;·&nbsp; SCORE " + pad(score) +
                    " &nbsp;·&nbsp; BEST " + pad(best) + statusTag() + " &nbsp;<span>ESC</span>";
  }

  /* ---- events ---- */
  window.addEventListener("mousemove", function (e) {
    if (active && locked) { pendingX += e.movementX || 0; pendingY += e.movementY || 0; }
    else { freeMouse.x = e.clientX; freeMouse.y = e.clientY; }
  }, { passive: true });

  document.addEventListener("dblclick", function (e) {
    if (performance.now() - lastStopAt < 350) return;
    if (e.target.closest && e.target.closest("a, button, input, .menu, .dock, .topbar, .theme-toggle")) return;
    start(e.clientX, e.clientY);
  });

  window.addEventListener("click", function () {
    if (!active) return;
    if (chr.air > 0) { doSpin(); return; }
    var el = document.elementFromPoint(chr.x, chr.y);
    var toggle = el && el.closest ? el.closest(".theme-toggle") : null;
    if (toggle) { toggle.click(); return; }
    var link = el && el.closest ? el.closest("a[href]") : null;
    stop();
    if (link) link.click();
  }, true);

  window.addEventListener("keydown", function (e) {
    if (!active) return;
    if (e.key === "Escape") { stop(); return; }
    if (e.key === " " || e.code === "Space") { if (chr.air > 0) { e.preventDefault(); doFlip(); } }
  });

  function onLockChange() {
    locked = !!lockEl();
    if (active && !locked) stop();
  }
  document.addEventListener("pointerlockchange", onLockChange);
  document.addEventListener("mozpointerlockchange", onLockChange);
  document.addEventListener("pointerlockerror", function () { locked = false; });

  /* the "double-click to play" nudge lives in the footer copy now */
  function hideHint() { hint.classList.remove("is-on"); }

})();
