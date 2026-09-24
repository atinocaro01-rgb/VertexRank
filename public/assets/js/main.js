/* VertexRank landing site: progressive enhancement only.
   The page is fully readable and navigable without this file. */
(function () {
  "use strict";

  var header = document.querySelector(".site-header");
  var toggle = document.querySelector(".menu-toggle");
  var nav = document.getElementById("primary-nav");

  /* Header shadow once the page scrolls */
  function onScroll() {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 10);
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* Mobile menu */
  function setMenu(open) {
    if (!toggle || !nav) return;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    nav.classList.toggle("is-open", open);
  }
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      setMenu(toggle.getAttribute("aria-expanded") !== "true");
    });
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) setMenu(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
        setMenu(false);
        toggle.focus();
      }
    });
  }

  if (!("IntersectionObserver" in window)) {
    /* Older browsers: show rings in their final state, skip scrollspy */
    document.documentElement.classList.remove("js");
    return;
  }

  /* Scrollspy: mark the nav link of the section in view (one-page nav only) */
  var links = nav ? Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"], a[href^="/#"]')) : [];
  var map = {};
  links.forEach(function (a) {
    var id = a.getAttribute("href").replace(/^\/?#/, "");
    if (id) map[id] = a;
  });
  var spy = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      links.forEach(function (a) { a.removeAttribute("aria-current"); });
      var a = map[entry.target.id];
      if (a) a.setAttribute("aria-current", "true");
    });
  }, { rootMargin: "-45% 0px -50% 0px", threshold: 0 });
  Object.keys(map).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) spy.observe(el);
  });

  /* Animate the sample score rings once, when they scroll into view */
  var rings = document.querySelector(".rings");
  if (rings) {
    var once = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.35 });
    once.observe(rings);
  }
})();
