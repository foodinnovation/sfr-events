/* SFR hub /services/: pick a question, see the matching services, open one in detail.
   The chosen question and service stay in the address (?q=market&s=maas) so a link can open the
   page on them. Signed-in members and staff also see the services where members get better terms.
   Counts question choices, opened services and their buttons (svc_click). Stores nothing. */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function track(ref) { if (window.SFR && window.SFR.track) window.SFR.track("svc_click", ref); }

  var panels = $$("[data-panel]"), items = $$("[data-item]"), qs = $$("[data-q]");
  if (!panels.length) return;
  var state = { q: (qs.filter(function (b) { return b.classList.contains("is-on"); })[0] || qs[0]).dataset.q, s: null };

  function bestOf(q) { var c = $('[data-panel="' + q + '"] [data-svc]'); return c ? c.dataset.svc : null; }
  function save() {
    var u = new URL(location.href);
    u.searchParams.set("q", state.q);
    if (state.s && state.s !== bestOf(state.q)) u.searchParams.set("s", state.s); else u.searchParams.delete("s");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
  }
  function showService(k, scroll) {
    if (!$('[data-item="' + k + '"]')) return;
    state.s = k;
    items.forEach(function (a) { a.hidden = a.dataset.item !== k; });
    $$(".svc-card").forEach(function (c) { c.classList.toggle("is-on", c.dataset.svc === k); });
    save();
    if (scroll) {
      var d = $("#svc-detail"), r = d.getBoundingClientRect();
      if (r.top < 0 || r.top > window.innerHeight * 0.6) d.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
  function showQuestion(q) {
    if (!$('[data-panel="' + q + '"]')) return;
    state.q = q;
    panels.forEach(function (p) { p.hidden = p.dataset.panel !== q; });
    qs.forEach(function (b) { var on = b.dataset.q === q; b.classList.toggle("is-on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); });
    showService(bestOf(q), false);
  }

  qs.forEach(function (b) {
    b.addEventListener("click", function () { showQuestion(b.dataset.q); track("question: " + b.dataset.q); });
  });
  document.addEventListener("click", function (e) {
    var c = e.target.closest("[data-svc]");
    if (c) {
      var inOverview = !c.closest(".svc-matches");
      showService(c.dataset.svc, true);
      track((c.closest(".svc-actions") ? "next: " : "service: ") + c.dataset.svc);
      if (inOverview && !c.closest(".svc-actions")) {
        var d = $("#svc-detail"); d.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }
    var a = e.target.closest("[data-svc-cta]");
    if (a) track("cta: " + a.dataset.svcCta);
  });

  // Start from the address, if it names a question or a service
  var p = new URLSearchParams(location.search);
  if (p.get("q")) showQuestion(p.get("q"));
  if (p.get("s")) showService(p.get("s"), false);

  // Members and staff: the services where members get better terms
  document.addEventListener("sfr:session", function (e) {
    var a = e.detail.access, member = !!(e.detail.session && a && (a.access === "member" || a.access === "staff"));
    var box = $("#svc-mine");
    if (box) box.hidden = !member;
  });
})();
