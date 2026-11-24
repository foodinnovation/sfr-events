/* SFR hub: Pulse tab. Loads stories from functions/v1/pulse (staff only until the tab is opened),
   filters them in the browser, shows one story at ?s=<id>, and lets members mark a story useful.
   Stores nothing in the browser. */
(function () {
  "use strict";
  var cfg = window.SFR_EVENTS || {};
  var FN = cfg.supabaseUrl + "/functions/v1/pulse";
  var root = document.getElementById("pulse");
  if (!root) return;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = (document.querySelector('link[rel="icon"]') || {}).href || "";
  BASE = BASE.replace(/assets\/img\/favicon\.svg.*$/, "");

  var IG = {   // pipeline slug -> hub name and Design System icon
    "zgl": ["Future Proof Farming", "future-oriented-farming"],
    "digitalization": ["Digitalization", "digitalization"],
    "proteins4future": ["Proteins4Future", "protein4future"],
    "verpackung": ["Packaging", "packaging"],
    "aquakultur": ["Aquaculture", "aquaculture"],
    "bioconversion": ["Bioconversion", "bioconversion"],
    "nonthermalpreservation": ["Non-Thermal Preservation", "non-thermal-preservation"],
    "sustainablenutrition": ["Sustainable Nutrition", "sustainable-nutrition"],
    "getreide-backwaren": ["Grains & Baked Goods", "bread-baked-goods"],
    "insekten": ["Insects", "insects"],
    "pilze": ["Fungi & Fungal Systems", "fungi"],
    "schokolade": ["Cocoa & Chocolate", "cocoa-chocolate"],
    "kaffee": ["Coffee", "coffee"]
  };
  var SCOPE = { swiss: "Switzerland", europe: "Europe", global: "Global" };
  var LANG = { de: "German", fr: "French", it: "Italian", nl: "Dutch", es: "Spanish" };
  var SOURCE = {   // newsletter senders appear by domain; a few get their usual name
    "lid.ch": "LID", "schweizerbauer.ch": "Schweizer Bauer", "foodaktuell.ch": "foodaktuell",
    "agroscope.ch": "Agroscope", "blv.admin.ch": "BLV", "blw.admin.ch": "BLW", "agridea.ch": "Agridea",
    "bauernzeitung.ch": "BauernZeitung", "fibl.org": "FiBL"
  };

  var session = null, access = null, data = null, can = false, started = false;
  var state = { scope: "all", ig: "", q: "", sort: "new" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function note(msg, html) {
    var n = $("#pl-note");
    n.hidden = !msg;
    if (html) n.innerHTML = msg; else n.textContent = msg || "";
  }
  function srcName(s) {   // feed names carry notes in brackets; OpenAlex items are research papers
    var n = SOURCE[s] || String(s || "").replace(/\s*\(.*\)\s*$/, "");
    return n === "OpenAlex" ? "Research paper" : n;
  }
  function icon(name) {
    return '<span class="ig-icon" style="--icon:url(' + BASE + "assets/img/ig/" + name + '.svg)" aria-hidden="true"></span>';
  }
  function dayDiff(iso) {
    var a = new Date(iso), b = new Date();
    var d0 = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()), d1 = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.max(0, Math.round((d1 - d0) / 86400000));
  }
  function added(iso) {
    var d = dayDiff(iso);
    return d === 0 ? "Added today" : d === 1 ? "Added yesterday" : "Added " + d + " days ago";
  }
  function lang(code) {
    var l = LANG[String(code || "").slice(0, 2).toLowerCase()];
    return l ? "original in " + l : "";
  }
  function tags(s) {
    var t = (s.igs || []).filter(function (g) { return IG[g]; }).map(function (g) {
      return '<span class="tag tag-ig">' + icon(IG[g][1]) + esc(IG[g][0]) + "</span>";
    });
    if (SCOPE[s.scope]) t.push('<span class="tag">' + SCOPE[s.scope] + "</span>");
    return '<div class="tags">' + t.join("") + "</div>";
  }
  function meta(s) {
    var m = [esc(srcName(s.source))];
    var l = lang(s.lang); if (l) m.push(l);
    var more = (s.sources || []).length - 1;
    if (more > 0) m.push("+" + more + (more === 1 ? " report" : " reports"));
    return m.join(" · ") + ' · <span class="pl-added">' + added(s.added) + "</span>";
  }
  function voteBtn(s) {
    var label = s.mine ? "Marked useful" : "Useful";
    return '<button type="button" class="pl-vote' + (s.mine ? " is-on" : "") + '" data-vote="' + esc(s.id) +
      '" aria-pressed="' + (s.mine ? "true" : "false") + '">' + label + ' <span class="pl-n">' + (s.votes || 0) + "</span></button>";
  }
  function storyHref(s) { return "?s=" + encodeURIComponent(s.id); }

  function itemHtml(s) {
    return '<li class="pl-item">' + tags(s) +
      '<a class="item-title" href="' + storyHref(s) + '" data-open="' + esc(s.id) + '">' + esc(s.title) + "</a>" +
      '<p class="item-meta">' + meta(s) + "</p>" +
      '<p class="pl-summary">' + esc(s.summary) + "</p>" +
      '<div class="pl-actions"><a href="' + esc(s.url) + '" rel="noopener" target="_blank">Original <span aria-hidden="true">&#8599;</span></a>' +
      voteBtn(s) + "</div></li>";
  }
  function leadHtml(s) {
    return '<article class="pl-lead"><p class="pl-kicker">Top story</p>' + tags(s) +
      '<a class="pl-lead-title" href="' + storyHref(s) + '" data-open="' + esc(s.id) + '">' + esc(s.title) + "</a>" +
      '<p class="item-meta">' + meta(s) + "</p>" +
      '<p class="pl-lead-summary">' + esc(s.summary) + "</p>" +
      '<div class="pl-actions"><a href="' + esc(s.url) + '" rel="noopener" target="_blank">Read the original <span aria-hidden="true">&#8599;</span></a>' +
      voteBtn(s) + "</div></article>";
  }

  /* ------------------------------------------------------------------ feed */
  function sorted(list) {
    var l = list.slice();
    if (state.sort === "new") l.sort(function (a, b) { return a.added.slice(0, 10) < b.added.slice(0, 10) ? 1 : a.added.slice(0, 10) > b.added.slice(0, 10) ? -1 : b.rel - a.rel; });
    else if (state.sort === "votes") l.sort(function (a, b) { return (b.votes || 0) - (a.votes || 0) || b.rel - a.rel || (a.added < b.added ? 1 : -1); });
    return l;   // "rel": the server's order (relevance, then newest)
  }
  function matches(s) {
    if (state.scope !== "all" && s.scope !== state.scope) return false;
    if (state.ig && (s.igs || []).indexOf(state.ig) < 0) return false;
    if (state.q) {
      var hay = (s.title + " " + s.summary + " " + s.source + " " + (s.igs || []).map(function (g) { return IG[g] ? IG[g][0] : ""; }).join(" ")).toLowerCase();
      if (hay.indexOf(state.q) < 0) return false;
    }
    return true;
  }
  function pickLead(list) {   // the most relevant story of the last three days, newest first
    var recent = list.filter(function (s) { return dayDiff(s.added) <= 3; });
    recent.sort(function (a, b) { return b.rel - a.rel || (a.added < b.added ? 1 : -1); });
    return recent[0] || list[0];
  }
  function renderIgChips() {
    var n = {};
    data.stories.forEach(function (s) { (s.igs || []).forEach(function (g) { if (IG[g]) n[g] = (n[g] || 0) + 1; }); });
    var keys = Object.keys(n).sort(function (a, b) { return n[b] - n[a]; });
    var box = $("#pl-igs");
    box.innerHTML = '<button type="button" class="chip' + (state.ig ? "" : " is-on") + '" data-ig="" aria-pressed="' + (!state.ig) + '">All Innovation Groups</button>' +
      keys.map(function (g) {
        var on = state.ig === g;
        return '<button type="button" class="chip' + (on ? " is-on" : "") + '" data-ig="' + g + '" aria-pressed="' + on + '">' + esc(IG[g][0]) + "</button>";
      }).join("");
    box.hidden = !keys.length;
  }
  function renderFeed() {
    var all = data.stories;
    var filtered = state.scope !== "all" || state.ig || state.q;
    var list = sorted(all.filter(matches));
    var lead = !filtered && state.sort === "new" ? pickLead(list) : null;
    $("#pl-lead").innerHTML = lead ? leadHtml(lead) : "";
    var rest = list.filter(function (s) { return s !== lead; });
    $("#pl-list").innerHTML = rest.map(itemHtml).join("");
    var head = $("#pl-list-head");
    head.hidden = !rest.length;
    head.textContent = filtered ? list.length + (list.length === 1 ? " story" : " stories") : "More from the last " + data.days + " days";
    $("#pl-empty").hidden = list.length > 0;
  }

  /* ------------------------------------------------------------------ one story */
  function renderStory(s) {
    var reports = (s.sources || []).map(function (r) {
      return '<li class="deck"><span><a class="deck-title" href="' + esc(r.url) + '" rel="noopener" target="_blank">' + esc(r.title) + "</a>" +
        '<span class="muted pl-small"> · ' + esc(srcName(r.name)) + " · " + added(r.at).toLowerCase() + "</span></span>" +
        '<a class="btn btn-ghost btn-sm" href="' + esc(r.url) + '" rel="noopener" target="_blank">Open &#8599;</a></li>';
    }).join("");
    var igs = (s.igs || []).filter(function (g) { return IG[g]; }).map(function (g) { return IG[g][0]; });
    $("#pl-story").innerHTML =
      '<p class="pl-back"><a href="./" data-back>&larr; Back to Pulse</a></p>' + tags(s) +
      '<h2 class="pl-story-title">' + esc(s.title) + "</h2>" +
      '<p class="item-meta">' + meta(s) + "</p>" +
      '<section class="pl-card pl-summary-card"><p class="pl-ai"><span class="pl-badge">AI summary</span> Written by AI from the reports below. Check the originals before you quote it.</p>' +
      '<p class="pl-lead-summary">' + esc(s.summary) + "</p>" +
      (igs.length ? '<p class="pl-small muted">Innovation Groups: ' + esc(igs.join(", ")) + "</p>" : "") + "</section>" +
      '<h3 class="pl-h3">Reported by</h3><ul class="decks">' + reports + "</ul>" +
      '<div class="pl-actions pl-story-actions">' + voteBtn(s) +
      '<a href="mailto:contact@swissfoodresearch.ch?subject=' + encodeURIComponent("Pulse: wrong summary") + "&body=" +
      encodeURIComponent(location.href) + '">Report a wrong summary</a></div>';
    document.title = s.title + " | Pulse | Swiss Food Research";
  }

  /* ------------------------------------------------------------------ loading */
  function headers() {
    var h = {};
    if (session) h.Authorization = "Bearer " + session.access_token;
    return h;
  }
  function closed(status, body) {
    var signedIn = !!session;
    $("#pl-feed").hidden = true; $("#pl-story").hidden = true;
    if (body && body.detail === "not_open_yet") {
      note(signedIn ? "Pulse is in a test run and opens to everyone in December. Staff can preview it now."
                    : 'Pulse is in a test run and opens to everyone in December. Staff can preview it after <a href="#" data-pl-signin>signing in</a>.', !signedIn);
    } else if (status === 404) {
      note('This story is no longer in Pulse. <a href="./" data-back>Back to Pulse</a>', true);
    } else {
      note("Pulse could not be loaded. Please try again later.");
    }
  }
  function current() { return new URLSearchParams(location.search).get("s"); }
  function show() {
    var id = current();
    note("Loading Pulse…");
    var url = FN + (id ? "?item=" + encodeURIComponent(id) : "?days=14");
    fetch(url, { headers: headers() }).then(function (r) {
      return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
    }).then(function (res) {
      if (!res.ok) { closed(res.status, res.body); return; }
      can = !!res.body.can_vote;
      var hero = document.querySelector(".pl-hero");
      if (hero) hero.classList.toggle("hero-compact", !!id);   // a story keeps the band short
      if (id) {
        $("#pl-feed").hidden = true; $("#pl-story").hidden = false;
        renderStory(res.body.stories[0]);
      } else {
        data = res.body;
        $("#pl-story").hidden = true; $("#pl-feed").hidden = false;
        $("#pl-filters").hidden = false;
        renderIgChips(); renderFeed();
        document.title = "Pulse | Swiss Food Research";
      }
      note("");
      window.scrollTo(0, 0);
    }).catch(function () { closed(0, null); });
  }
  function go(href) { history.pushState({}, "", href); show(); }

  /* ------------------------------------------------------------------ votes */
  function vote(id, btn) {
    if (!session) { if (window.SFR) window.SFR.openDialog(); return; }
    if (!can) { if (window.SFR) window.SFR.toast("Votes are for members of Swiss Food Research."); return; }
    var on = btn.getAttribute("aria-pressed") !== "true";
    btn.disabled = true;
    fetch(FN, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers()),
                body: JSON.stringify({ item: id, on: on }) })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        btn.disabled = false;
        if (!res.ok) { if (window.SFR) window.SFR.toast("Your vote could not be saved."); return; }
        [data && data.stories].forEach(function (l) { (l || []).forEach(function (s) { if (s.id === id) { s.votes = res.body.votes; s.mine = res.body.mine; } }); });
        $$('[data-vote="' + id + '"]').forEach(function (b) {
          b.classList.toggle("is-on", res.body.mine);
          b.setAttribute("aria-pressed", res.body.mine ? "true" : "false");
          b.innerHTML = (res.body.mine ? "Marked useful" : "Useful") + ' <span class="pl-n">' + res.body.votes + "</span>";
        });
      })
      .catch(function () { btn.disabled = false; });
  }

  /* ------------------------------------------------------------------ events */
  root.addEventListener("click", function (e) {
    var t = e.target.closest("[data-open],[data-back],[data-vote],[data-pl-signin],.chip");
    if (!t) return;
    if (t.hasAttribute("data-open")) { e.preventDefault(); go("?s=" + encodeURIComponent(t.getAttribute("data-open"))); }
    else if (t.hasAttribute("data-back")) { e.preventDefault(); go(location.pathname); }
    else if (t.hasAttribute("data-vote")) { vote(t.getAttribute("data-vote"), t); }
    else if (t.hasAttribute("data-pl-signin")) { e.preventDefault(); if (window.SFR) window.SFR.openDialog(); }
    else if (t.hasAttribute("data-scope")) {
      state.scope = t.getAttribute("data-scope");
      $$("[data-scope]").forEach(function (c) { var on = c === t; c.classList.toggle("is-on", on); c.setAttribute("aria-pressed", on); });
      renderFeed();
    } else if (t.hasAttribute("data-ig")) {
      state.ig = t.getAttribute("data-ig");
      renderIgChips(); renderFeed();
    }
  });
  var qTimer = null;
  $("#pl-q").addEventListener("input", function (e) {
    clearTimeout(qTimer);
    qTimer = setTimeout(function () { state.q = e.target.value.trim().toLowerCase(); if (data) renderFeed(); }, 150);
  });
  $("#pl-sort").addEventListener("change", function (e) { state.sort = e.target.value; if (data) renderFeed(); });
  window.addEventListener("popstate", show);

  function start(s, a) {
    var uid = function (x) { return x && x.user ? x.user.id : null; };
    var changed = !started || uid(session) !== uid(s);   // not on a token refresh
    session = s; access = a;
    $$("[data-pl-signin]").forEach(function (b) { b.hidden = !!s; });
    if (changed) { started = true; show(); }
  }
  document.addEventListener("sfr:session", function (e) { start(e.detail.session, e.detail.access); });
  setTimeout(function () { if (!started) start(null, null); }, 4000);   // sign-in check did not answer
})();
