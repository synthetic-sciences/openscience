/* =============================================================================
   OpenScience landing interactions
   Warm-dark, dark-only. Each feature is isolated in its own try/catch so a
   failure in one never blanks the page (see the failsafe reveal in index.html).
   Sets window.__osReady when it finishes cleanly.
   ========================================================================== */
(function () {
  "use strict";

  var reduceMotion = false;
  try { reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  function guard(fn) { try { fn(); } catch (e) {} }

  /* -------------------------------------------------- sticky nav shadow */
  guard(function () {
    var nav = document.getElementById("nav");
    if (!nav) return;
    var onScroll = function () { nav.classList.toggle("stuck", window.scrollY > 8); };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  });

  /* -------------------------------------------------- reveal (rise on scroll) */
  guard(function () {
    var reveals = document.querySelectorAll(".reveal");
    var showAll = function () { for (var i = 0; i < reveals.length; i++) reveals[i].classList.add("in"); };
    if (reduceMotion || !("IntersectionObserver" in window)) { showAll(); return; }
    try {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var el = e.target;
          var parent = el.parentElement;
          var sibs = parent ? Array.prototype.slice.call(parent.querySelectorAll(":scope > .reveal")) : [el];
          var idx = Math.max(0, sibs.indexOf(el));
          el.style.animationDelay = Math.min(idx * 70, 320) + "ms";
          el.classList.add("in");
          io.unobserve(el);
        });
      }, { threshold: 0.14, rootMargin: "0px 0px -7% 0px" });
      reveals.forEach(function (el) { io.observe(el); });
    } catch (e) { showAll(); }   // never leave content hidden if the observer fails
  });

  /* -------------------------------------------------- install command */
  var CURL = "curl -fsSL https://openscience.sh/install | bash";

  /* -------------------------------------------------- clipboard */
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    } catch (e) {}
    return new Promise(function (resolve) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", "");
        ta.style.position = "absolute"; ta.style.left = "-9999px";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
      } catch (e) {}
      resolve();
    });
  }
  guard(function () {
    // install codeblock copy button (label swaps to "Copied")
    var btn = document.getElementById("installCopy");
    if (btn) {
      var label = btn.querySelector(".cbt-label");
      var original = label ? label.textContent : "";
      btn.addEventListener("click", function () {
        copyText(CURL).then(function () {
          btn.classList.add("copied");
          if (label) label.textContent = "Copied";
          setTimeout(function () { btn.classList.remove("copied"); if (label) label.textContent = original; }, 1600);
        });
      });
    }
    // hero + CTA install chips (whole chip is the button; the icon goes green)
    ["heroChip", "ctaChip"].forEach(function (id) {
      var chip = document.getElementById(id);
      if (!chip) return;
      chip.addEventListener("click", function () {
        copyText(CURL).then(function () {
          chip.classList.add("copied");
          setTimeout(function () { chip.classList.remove("copied"); }, 1600);
        });
      });
    });
  });

  /* -------------------------------------------------- terminal: stream the session in, once */
  guard(function () {
    var term = document.querySelector(".term-svg");
    if (!term) return;
    var played = false;
    var play = function () { if (played) return; played = true; term.classList.add("play"); };
    if (reduceMotion || !("IntersectionObserver" in window)) { play(); return; }
    try {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) { play(); io.disconnect(); } });
      }, { threshold: 0.2 });
      io.observe(term);
    } catch (e) { play(); }
    // safety net: never leave the session hidden even if the observer never fires
    setTimeout(play, 6000);
  });

  window.__osReady = true;
})();
