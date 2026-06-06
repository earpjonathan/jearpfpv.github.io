/* ============================================================
   Shared interactions — theme toggle, scroll reveal, year.
   Hub-only: floating cursor preview on the work index.
   ============================================================ */

/* ---- theme toggle (persisted) ---- */
(function () {
  var btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var d = document.documentElement;
    var next = d.dataset.theme === "dark" ? "light" : "dark";
    d.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch (e) {}
  });
})();

/* ---- reveal on scroll ---- */
(function () {
  var els = document.querySelectorAll("[data-reveal]");
  if (!els.length || !("IntersectionObserver" in window)) {
    els.forEach(function (el) { el.classList.add("is-in"); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
  els.forEach(function (el) { io.observe(el); });
})();

/* ---- footer year ---- */
(function () {
  var y = document.getElementById("year");
  if (y) y.textContent = new Date().getFullYear();
})();

/* ---- nav label letter-by-letter stagger ---- */
(function () {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var links = document.querySelectorAll(".topnav__link");
  links.forEach(function (link, li) {
    var text = link.textContent;
    link.textContent = "";
    link.classList.add("stagger");
    for (var i = 0; i < text.length; i++) {
      var s = document.createElement("span");
      if (text[i] === " ") { s.className = "sp"; s.innerHTML = "&nbsp;"; }
      else s.textContent = text[i];
      s.style.setProperty("--ci", li * 3 + i);
      link.appendChild(s);
    }
  });
})();

/* ---- scrolled nav state ---- */
(function () {
  function onScroll() {
    document.body.classList.toggle("scrolled", window.scrollY > 40);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
})();

/* ---- fullscreen hover preview for the cover menu ---- */
(function () {
  var peek = document.getElementById("peek");
  var media = document.getElementById("peek-media");
  if (!peek || !media) return;
  if (matchMedia("(hover: none)").matches) return;

  document.querySelectorAll("[data-peek]").forEach(function (item) {
    item.addEventListener("mouseenter", function () {
      var type = item.getAttribute("data-peek");
      var src = item.getAttribute("data-peek-src");
      media.innerHTML = "";
      if (type === "video") {
        var v = document.createElement("video");
        v.src = src; v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
        v.play().catch(function () {});
        media.appendChild(v);
      } else {
        var img = new Image();
        img.src = src;
        media.appendChild(img);
      }
      peek.classList.add("is-on");
      document.body.classList.add("peek-on");
    });
    item.addEventListener("mouseleave", function () {
      peek.classList.remove("is-on");
      document.body.classList.remove("peek-on");
      media.innerHTML = "";
    });
  });
})();
