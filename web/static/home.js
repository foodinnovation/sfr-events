/* SFR hub home page: Pulse's top three of the week, the click-to-load Calendly calendar, the
   members/visitors switch on the Radicle card, and counting of the home page's buttons.
   Calendly is contacted only after the visitor clicks "Show available slots". Stores nothing. */
(function () {
  "use strict";
  var cfg = window.SFR_EVENTS || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function track(kind, ref) { if (window.SFR && window.SFR.track) window.SFR.track(kind, ref); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ------------------------------------------------------------------ counting */
  $$("[data-home]").forEach(function (a) {
    a.addEventListener("click", function () { track("home_click", a.dataset.home + (a.dataset.ref ? ": " + a.dataset.ref : "")); });
  });

  /* ------------------------------------------------------------------ Calendly, on request only */
  var load = $("#cal-load");
  if (load) load.addEventListener("click", function () {
    var u = new URL(load.dataset.url);
    u.searchParams.set("embed_type", "Inline");
    u.searchParams.set("embed_domain", location.hostname);
    u.searchParams.set("hide_gdpr_banner", "1");
    u.searchParams.set("hide_event_type_details", "1");
    var box = $("#book-cal");
    box.innerHTML = '<iframe class="home-cal-frame" title="Book a free 1:1 session" src="' + esc(u.toString()) + '"></iframe>';
    box.classList.add("is-loaded");
    track("booking_open", "calendly");
  });

  /* ------------------------------------------------------------------ Pulse: top 3 this week */
  var news = $("#home-news"), split = $("#home-split");
  var SOURCE = { "lid.ch": "LID", "schweizerbauer.ch": "Schweizer Bauer", "foodaktuell.ch": "foodaktuell",
    "agroscope.ch": "Agroscope", "blv.admin.ch": "BLV", "blw.admin.ch": "BLW", "agridea.ch": "Agridea",
    "bauernzeitung.ch": "BauernZeitung", "fibl.org": "FiBL" };
  function srcName(s) {
    var n = SOURCE[s] || String(s || "").replace(/\s*\(.*\)\s*$/, "");
    return n === "OpenAlex" ? "Research paper" : n;
  }
  function age(iso) {
    var a = new Date(iso), b = new Date();
    var d = Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
    return d <= 0 ? "Added today" : d === 1 ? "Added yesterday" : "Added " + d + " days ago";
  }
  function show(stories) {
    var top = (stories || []).slice(0, 3);
    if (!top.length) { news.hidden = true; split.classList.add("is-solo"); return; }
    $("#home-stories").innerHTML = top.map(function (s) {
      return '<li class="home-story"><a class="home-story-title" href="pulse/?s=' + encodeURIComponent(s.id) + '" data-story="' + esc(s.id) + '">' +
        esc(s.title) + "</a>" + '<p class="home-story-sum">' + esc(s.summary) + "</p>" +
        '<p class="item-meta">' + esc(srcName(s.source)) + " · " + age(s.added) + "</p></li>";
    }).join("");
    $$("[data-story]", news).forEach(function (a) { a.addEventListener("click", function () { track("home_click", "pulse-story: " + a.dataset.story); }); });
    news.hidden = false; split.classList.remove("is-solo");
  }
  var asked = null;
  function loadPulse(session, access) {
    var isPublic = news && news.dataset.public === "1";
    var staff = access && access.access === "staff";
    if (!news || !(isPublic || staff)) { if (news) { news.hidden = true; split.classList.add("is-solo"); } return; }
    var key = session ? session.access_token : "anon";
    if (asked === key) return;
    asked = key;
    var h = {};
    if (session) h.Authorization = "Bearer " + session.access_token;
    fetch(cfg.supabaseUrl + "/functions/v1/pulse?days=7", { headers: h }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (b) { show(b && b.stories); }).catch(function () { show(null); });
  }

  /* ------------------------------------------------------------------ members or visitors */
  document.addEventListener("sfr:session", function (e) {
    var a = e.detail.access, member = !!(e.detail.session && a && (a.access === "member" || a.access === "staff"));
    $$("[data-for=members]").forEach(function (x) { x.hidden = !member; });
    $$("[data-for=public]").forEach(function (x) { x.hidden = member; });
    loadPulse(e.detail.session, a);
  });
  $$("[data-home-signin]").forEach(function (b) {
    b.addEventListener("click", function () { if (window.SFR && window.SFR.openDialog) window.SFR.openDialog(); });
  });
  if (news && news.dataset.public === "1") loadPulse(null, null);
})();
