/* ============================================================
   Interactive topographic field — Swiss-passport inspired.
   Renders animated contour (iso) lines via marching squares.
   The cursor acts like a rising peak: contours bulge around it,
   and a live elevation readout follows the pointer.
   Self-contained; reads --fg / --accent from the active theme.
   ============================================================ */
(function () {
  var canvas = document.querySelector("canvas[data-topo]");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  var host = canvas.parentElement;
  var readout = document.getElementById("topo-read");

  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var hoverable = matchMedia("(hover: hover)").matches;
  /* Cursor interaction is pointer-driven, so we allow it even under
     reduced-motion; only the autonomous drift below is suppressed. */
  var interactive = canvas.getAttribute("data-interactive") === "true" && hoverable;

  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var cell = 30;
  var W = 0, H = 0, cols = 0, rows = 0, field = null;
  var fg = "#0a0a0a", accent = "#1e3fe5";
  var t = 0, visible = true, raf = null;

  var m = { x: -9999, y: -9999, tx: -9999, ty: -9999, on: false, amp: 0,
            panx: 0, pany: 0, ptx: 0, pty: 0 };
  var PAN = 1.6; /* how far the terrain glides relative to cursor travel */

  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    fg = (cs.getPropertyValue("--fg") || "#0a0a0a").trim() || fg;
    accent = (cs.getPropertyValue("--accent") || "#1e3fe5").trim() || accent;
  }

  function resize() {
    var r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    if (!W || !H) return;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(W / cell) + 1;
    rows = Math.ceil(H / cell) + 1;
    field = new Float32Array(cols * rows);
  }

  /* value noise */
  function hash(x, y) {
    var n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }
  function fade(w) { return w * w * w * (w * (w * 6 - 15) + 10); }
  function vnoise(x, y) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = fade(xf), v = fade(yf);
    var tl = hash(xi, yi), tr = hash(xi + 1, yi);
    var bl = hash(xi, yi + 1), br = hash(xi + 1, yi + 1);
    var top = tl + (tr - tl) * u, bot = bl + (br - bl) * u;
    return top + (bot - top) * v;
  }
  function baseAt(px, py) {
    var x = px + m.panx, y = py + m.pany;
    return vnoise(x * 0.0023 + t, y * 0.0023 - t * 0.6) * 0.65 +
           vnoise(x * 0.0052 - t * 0.5, y * 0.0052 + t * 0.3) * 0.35;
  }

  function computeField() {
    var i = 0, sig2 = 2 * 168 * 168;
    for (var gy = 0; gy < rows; gy++) {
      for (var gx = 0; gx < cols; gx++) {
        var px = gx * cell, py = gy * cell;
        var val = baseAt(px, py);
        if (m.amp > 0.01) {
          var dx = px - m.x, dy = py - m.y;
          val += m.amp * Math.exp(-(dx * dx + dy * dy) / sig2);
        }
        field[i++] = val;
      }
    }
  }

  /* marching squares — append iso segments at threshold thr to current path */
  function marchLevel(thr, gx0, gy0, gx1, gy1) {
    for (var gy = gy0; gy < gy1; gy++) {
      var row = gy * cols;
      for (var gx = gx0; gx < gx1; gx++) {
        var i0 = row + gx;
        var tl = field[i0], tr = field[i0 + 1], bl = field[i0 + cols], br = field[i0 + cols + 1];
        var idx = (tl > thr ? 8 : 0) | (tr > thr ? 4 : 0) | (br > thr ? 2 : 0) | (bl > thr ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        var x = gx * cell, y = gy * cell;
        var T = function () { return [x + cell * cross(tl, tr, thr), y]; };
        var R = function () { return [x + cell, y + cell * cross(tr, br, thr)]; };
        var B = function () { return [x + cell * cross(bl, br, thr), y + cell]; };
        var Lf = function () { return [x, y + cell * cross(tl, bl, thr)]; };
        switch (idx) {
          case 1: seg(Lf(), B()); break;
          case 2: seg(B(), R()); break;
          case 3: seg(Lf(), R()); break;
          case 4: seg(T(), R()); break;
          case 5: seg(T(), Lf()); seg(B(), R()); break;
          case 6: seg(T(), B()); break;
          case 7: seg(T(), Lf()); break;
          case 8: seg(T(), Lf()); break;
          case 9: seg(T(), B()); break;
          case 10: seg(Lf(), B()); seg(T(), R()); break;
          case 11: seg(T(), R()); break;
          case 12: seg(Lf(), R()); break;
          case 13: seg(B(), R()); break;
          case 14: seg(Lf(), B()); break;
        }
      }
    }
  }
  function cross(a, b, thr) {
    var d = b - a;
    return Math.abs(d) < 1e-6 ? 0.5 : (thr - a) / d;
  }
  function seg(a, b) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }

  function draw() {
    if (!field) return;
    computeField();
    ctx.clearRect(0, 0, W, H);
    var levels = 13;
    for (var L = 1; L < levels; L++) {
      var thr = L / levels;
      var index = (L % 3 === 0);
      ctx.beginPath();
      marchLevel(thr, 0, 0, cols - 1, rows - 1);
      ctx.globalAlpha = index ? 0.42 : 0.2;
      ctx.lineWidth = index ? 1.2 : 0.8;
      ctx.strokeStyle = fg;
      ctx.stroke();
    }
    if (m.amp > 0.05) {
      var rad = 150;
      var gx0 = Math.max(0, Math.floor((m.x - rad) / cell));
      var gy0 = Math.max(0, Math.floor((m.y - rad) / cell));
      var gx1 = Math.min(cols - 1, Math.ceil((m.x + rad) / cell));
      var gy1 = Math.min(rows - 1, Math.ceil((m.y + rad) / cell));
      ctx.save();
      ctx.beginPath();
      ctx.arc(m.x, m.y, rad, 0, Math.PI * 2);
      ctx.clip();
      ctx.beginPath();
      for (var La = 1; La < levels; La++) marchLevel(La / levels, gx0, gy0, gx1, gy1);
      ctx.globalAlpha = 0.6 * Math.min(1, m.amp / 0.55);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = accent;
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = Math.min(1, m.amp / 0.55);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* The loop runs only while the pointer is active, then settles to a
     static frame. Keeps it reactive + battery-friendly, and lets the
     page reach a stable frame for capture. */
  var lastMove = -9999;
  function kick() { if (raf == null) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = null;
    if (!visible) return;
    var idleFor = (typeof performance !== "undefined" ? performance.now() : Date.now()) - lastMove;
    var panMoving = Math.abs(m.ptx - m.panx) > 0.4 || Math.abs(m.pty - m.pany) > 0.4;
    var active = m.on || m.amp > 0.02 || idleFor < 1400 || panMoving;
    if (active && !reduce) t += 0.0011;
    m.x += (m.tx - m.x) * 0.12;
    m.y += (m.ty - m.y) * 0.12;
    m.panx += (m.ptx - m.panx) * 0.06;
    m.pany += (m.pty - m.pany) * 0.06;
    m.amp += ((m.on ? 0.6 : 0) - m.amp) * 0.08;
    draw();
    if (readout && m.on) {
      var elev = Math.round((baseAt(m.x, m.y) * 1850 + 540) / 2) * 2;
      readout.textContent = "▲ " + elev.toLocaleString() + " M";
    }
    if (active) raf = requestAnimationFrame(frame);
  }

  /* events */
  window.addEventListener("resize", function () { resize(); render1(); });
  window.addEventListener("load", function () { resize(); render1(); });
  if ("ResizeObserver" in window) {
    new ResizeObserver(function () { resize(); if (raf == null) render1(); }).observe(canvas);
  }

  function render1() { computeField(); draw(); } /* one static frame */

  readColors();
  resize();

  if (interactive) {
    /* listen on the whole window so the terrain pans as the cursor
       roams anywhere on screen, not just over the canvas */
    window.addEventListener("mousemove", function (e) {
      var r = canvas.getBoundingClientRect();
      m.tx = e.clientX - r.left;
      m.ty = e.clientY - r.top;
      if (!m.on) { m.x = m.tx; m.y = m.ty; }
      m.on = true;
      m.ptx = (m.tx - W / 2) * PAN;
      m.pty = (m.ty - H / 2) * PAN;
      lastMove = (typeof performance !== "undefined" ? performance.now() : Date.now());
      if (readout) {
        readout.style.left = e.clientX + "px";
        readout.style.top = e.clientY + "px";
        readout.classList.add("is-on");
      }
      kick();
    });
    document.addEventListener("mouseleave", function () {
      m.on = false;
      if (readout) readout.classList.remove("is-on");
      kick();
    });
  }

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) render1();
    }, { threshold: 0 }).observe(canvas);
  }

  new MutationObserver(function () { readColors(); if (raf == null) render1(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  /* capture hook: render a single static frame, no loop */
  window.__topo = {
    stop: function () { if (raf) { cancelAnimationFrame(raf); raf = null; } },
    still: function (mx, my) {
      this.stop();
      readColors();
      resize();
      if (mx != null) { m.on = true; m.amp = 0.6; m.x = m.tx = mx; m.y = m.ty = my; }
      render1();
    }
  };

  render1(); /* initial static frame; loop starts on first mouse move */
})();
