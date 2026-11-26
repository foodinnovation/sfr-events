/* SFR hub: Pulse tab. Loads stories from functions/v1/pulse (staff only until the tab is opened),
   filters them in the browser, shows one story at ?s=<id> and one Innovation Group at ?g=<slug>,
   and lets members mark a story useful. Pictures are SFR's own Innovation Group art.
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

  // pipeline slug -> hub name, Design System icon, artwork (none for Non-Thermal Preservation yet), one line on the group
  var IG = {
    "zgl": ["Future Proof Farming", "future-oriented-farming", "farming",
      "Farming practice, soils, crops and livestock, and the policy that shapes them."],
    "digitalization": ["Digitalization", "digitalization", "digitalization",
      "Data, sensors, AI and software along the food chain."],
    "proteins4future": ["Proteins4Future", "protein4future", "proteins4future",
      "Plant, fermented and cultivated proteins, from ingredient to market."],
    "verpackung": ["Packaging", "packaging", "packaging",
      "Packaging materials, recycling, design and the rules that govern them."],
    "aquakultur": ["Aquaculture", "aquaculture", "aquaculture",
      "Fish, shellfish and algae farming: feed, fish health, regulation and the business of farming in water."],
    "bioconversion": ["Bioconversion", "bioconversion", "bioconversion",
      "Turning side streams and biomass into food, feed and materials with fermentation and other biological processes."],
    "nonthermalpreservation": ["Non-Thermal Preservation", "non-thermal-preservation", "",
      "High pressure, pulsed electric fields and other ways to keep food safe without heat, and the food safety questions around them."],
    "sustainablenutrition": ["Sustainable Nutrition", "sustainable-nutrition", "sustainable-nutrition",
      "Diets, health and the environmental footprint of what we eat."],
    "getreide-backwaren": ["Grains & Baked Goods", "bread-baked-goods", "grains-baked-goods",
      "Cereals, milling and baking, from field to loaf."],
    "insekten": ["Insects", "insects", "insects",
      "Insects as food and feed: rearing, processing and regulation."],
    "pilze": ["Fungi & Fungal Systems", "fungi", "fungi",
      "Mushrooms, mycelium and fungal fermentation for food."],
    "schokolade": ["Cocoa & Chocolate", "cocoa-chocolate", "cocoa-chocolate",
      "Cocoa supply, chocolate making and the rules that govern them."],
    "kaffee": ["Coffee", "coffee", "coffee",
      "Coffee from farm to cup: supply, processing, quality and regulation."]
  };
  var SCOPE = { swiss: "Switzerland", europe: "Europe", global: "Global" };
  var LANG = { de: "German", fr: "French", it: "Italian", nl: "Dutch", es: "Spanish" };
  var SOURCE = {   // newsletter senders appear by domain; a few get their usual name
    "lid.ch": "LID", "schweizerbauer.ch": "Schweizer Bauer", "foodaktuell.ch": "foodaktuell",
    "agroscope.ch": "Agroscope", "blv.admin.ch": "BLV", "blw.admin.ch": "BLW", "agridea.ch": "Agridea",
    "bauernzeitung.ch": "BauernZeitung", "fibl.org": "FiBL"
  };
  var CROPS = 4, GRID = 9;

  var session = null, access = null, data = null, can = false, started = false;
  var state = { scope: "all", ig: "", q: "", sort: "new" };
  var heroHead = $("#pl-hero-head") ? $("#pl-hero-head").innerHTML : "";
  var used = {};   // crops already on screen, per artwork, so one picture does not repeat

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
  function week(iso) {   // 0 this week (from Monday), 1 last week, 2 earlier
    var sinceMonday = (new Date().getDay() + 6) % 7, d = dayDiff(iso);
    return d <= sinceMonday ? 0 : d <= sinceMonday + 7 ? 1 : 2;
  }
  function lang(code) {
    var l = LANG[String(code || "").slice(0, 2).toLowerCase()];
    return l ? "original in " + l : "";
  }
  function sc(s) { return s.score != null ? s.score : (s.rel || 0) * 20; }   // finer 0-100 score, else the 1-5 rating
  function igsOf(s) { return (s.igs || []).filter(function (g) { return IG[g]; }); }
  function meta(s) {
    var m = [esc(srcName(s.source))];
    var l = lang(s.lang); if (l) m.push(l);
    var more = (s.sources || []).length - 1;
    if (more > 0) m.push("+" + more + (more === 1 ? " report" : " reports"));
    return m.join(" · ");
  }
  function voteBtn(s) {
    var label = s.mine ? "Marked useful" : "Useful";
    return '<button type="button" class="pl-vote' + (s.mine ? " is-on" : "") + '" data-vote="' + esc(s.id) +
      '" aria-pressed="' + (s.mine ? "true" : "false") + '">' + label + ' <span class="pl-n">' + (s.votes || 0) + "</span></button>";
  }
  function storyHref(s) { return "?s=" + encodeURIComponent(s.id); }
  function original(s, text) {
    return '<a href="' + esc(s.url) + '" rel="noopener" target="_blank">' + (text || "Original") + ' <span aria-hidden="true">&#8599;</span></a>';
  }

  /* ------------------------------------------------------------------ pictures */
  function mainIg(s) { var g = igsOf(s); return state.ig && g.indexOf(state.ig) >= 0 ? state.ig : g[0] || ""; }
  function artUrl(g, size) {
    var a = g && IG[g] ? IG[g][2] : "";
    return BASE + "assets/img/ig-art/" + (a || "general-dark") + "-" + size + ".jpg";
  }
  function crop(s, g) {   // a fixed crop per story; the next free one if that crop is already on screen
    var key = g || "-", start = parseInt(String(s.id).slice(0, 6), 16) % CROPS || 0;
    used[key] = used[key] || {};
    for (var i = 0; i < CROPS; i++) {
      var c = (start + i) % CROPS;
      if (!used[key][c]) { used[key][c] = true; return c; }
    }
    return start;
  }
  function picture(s, cls) {
    var g = mainIg(s), noArt = !g || !IG[g][2];
    return '<div class="pl-pic ' + (cls || "") + '"><div class="pl-pic-in">' +
      '<img class="pl-img crop-' + crop(s, g) + '" src="' + artUrl(g, "card") + '" alt="" loading="lazy" decoding="async">' +
      (noArt && g ? '<span class="pl-pic-icon">' + icon(IG[g][1]) + "</span>" : "") + "</div>" +
      (g ? '<span class="pl-pic-tag">' + icon(IG[g][1]) + esc(IG[g][0]) + "</span>" : "") + "</div>";
  }

  /* ------------------------------------------------------------------ pieces */
  function chipsFor(s, also) {
    return igsOf(s).filter(function (g) { return g !== state.ig; }).map(function (g) {
      return '<span class="pl-igchip">' + icon(IG[g][1]) + (also ? "Also " : "") + esc(IG[g][0]) + "</span>";
    }).join("");
  }
  function alsoChips(s) {   // the story's other groups, after the one on the picture
    var m = mainIg(s), c = igsOf(s).filter(function (g) { return g !== m; }).map(function (g) {
      return '<span class="pl-igchip">' + icon(IG[g][1]) + "Also " + esc(IG[g][0]) + "</span>";
    }).join("");
    return c ? '<p class="item-meta pl-also">' + c + "</p>" : "";
  }
  function leadHtml(s) {
    var g = mainIg(s);
    return '<article class="pl-lead pl-in">' +
      '<div class="pl-lead-pic pl-pic"><div class="pl-pic-in"><img class="pl-img" src="' + artUrl(g, "wide") + '" alt="">' +
      (g && !IG[g][2] ? '<span class="pl-pic-icon">' + icon(IG[g][1]) + "</span>" : "") + "</div>" +
      (g ? '<span class="pl-pic-tag">' + icon(IG[g][1]) + esc(IG[g][0]) + "</span>" : "") + "</div>" +
      '<div class="pl-lead-body"><p class="pl-kicker">Top story' + (SCOPE[s.scope] ? " · " + SCOPE[s.scope] : "") + "</p>" +
      '<a class="pl-lead-title" href="' + storyHref(s) + '" data-open="' + esc(s.id) + '">' + esc(s.title) + "</a>" +
      '<p class="item-meta">' + meta(s) + ' · <span class="pl-added">' + added(s.added) + "</span></p>" +
      '<p class="pl-lead-summary">' + esc(s.summary) + "</p>" +
      alsoChips(s) +
      '<div class="pl-actions">' + original(s, "Read the original") + voteBtn(s) + "</div></div></article>";
  }
  function cardHtml(s, i) {
    return '<article class="pl-tcard pl-in" style="--i:' + i + '">' + picture(s) +
      '<div class="pl-tcard-body"><p class="item-meta">' + (SCOPE[s.scope] ? SCOPE[s.scope] + " · " : "") + meta(s) +
      ' · <span class="pl-added">' + added(s.added) + "</span></p>" +
      '<a class="pl-tcard-title" href="' + storyHref(s) + '" data-open="' + esc(s.id) + '">' + esc(s.title) + "</a>" +
      '<p class="pl-clamp">' + esc(s.summary) + "</p>" +
      alsoChips(s) +
      '<div class="pl-actions">' + original(s) + voteBtn(s) + "</div></div></article>";
  }
  function rowHtml(s, i) {
    var chips = chipsFor(s, !!state.ig);
    return '<article class="pl-row pl-in" style="--i:' + Math.min(i, 8) + '">' +
      '<div class="pl-row-when"><span class="pl-added">' + added(s.added).replace("Added ", "").replace(/^./, function (c) { return c.toUpperCase(); }) +
      "</span>" + (SCOPE[s.scope] ? '<span class="muted">' + SCOPE[s.scope] + "</span>" : "") + "</div>" +
      '<div class="pl-row-main"><a class="pl-row-title" href="' + storyHref(s) + '" data-open="' + esc(s.id) + '">' + esc(s.title) + "</a>" +
      '<p class="pl-summary">' + esc(s.summary) + "</p>" +
      '<p class="item-meta pl-row-meta"><span>' + meta(s) + "</span>" + chips + "</p></div>" +
      '<div class="pl-actions pl-row-act">' + original(s) + voteBtn(s) + "</div></article>";
  }

  /* ------------------------------------------------------------------ hero and tiles */
  function best(list, scope) {
    return list.filter(function (s) { return s.scope === scope; })
      .sort(function (a, b) { return sc(b) - sc(a) || (a.added < b.added ? 1 : -1); })[0];
  }
  function tiles() {   // the week at a glance: top story per region and the most useful; follows the group filter
    var pool = data.stories.filter(function (s) { return !state.ig || (s.igs || []).indexOf(state.ig) >= 0; });
    var span = state.ig ? data.days : 7;
    pool = pool.filter(function (s) { return dayDiff(s.added) < span; });
    var useful = pool.filter(function (s) { return (s.votes || 0) > 0; })
      .sort(function (a, b) { return b.votes - a.votes || sc(b) - sc(a); })[0];
    var what = state.ig ? " on " + IG[state.ig][0] : "";
    var when = state.ig ? " in the last two weeks." : " this week.";
    return [
      ["Top in Switzerland", best(pool, "swiss"), "No Swiss story" + what + when],
      ["Top in Europe", best(pool, "europe"), "No European story" + what + when],
      ["Top worldwide", best(pool, "global"), "No story from beyond Europe" + what + when],
      ["Most useful", useful, "No votes yet. Members can mark stories useful."]
    ];
  }
  function tileHtml(t, i) {
    var s = t[1], pics = !state.ig;
    if (!s) return '<div class="pl-tile is-empty pl-in" style="--i:' + i + '"><span class="pl-tile-kicker">' + t[0] +
      '</span><p class="pl-tile-title">' + esc(t[2]) + "</p></div>";
    var m = t[0] === "Most useful" ? s.votes + (s.votes === 1 ? " member" : " members") : srcName(s.source) + " · " + added(s.added);
    return '<a class="pl-tile' + (pics ? " has-pic" : "") + ' pl-in" style="--i:' + i + '" href="' + storyHref(s) + '" data-open="' + esc(s.id) + '">' +
      (pics ? picture(s, "pl-tile-pic") : "") +
      '<span class="pl-tile-kicker">' + t[0] + '</span><span class="pl-tile-text"><span class="pl-tile-meta">' + esc(m) +
      '</span><span class="pl-tile-title">' + esc(s.title) + "</span></span></a>";
  }
  function renderHero(mode, s) {   // mode: feed, group or story
    var hero = $("#pl-hero"), art = $("#pl-hero-art"), head = $("#pl-hero-head"), box = $("#pl-tiles");
    var g = mode === "group" ? state.ig : mode === "story" ? mainIg(s) : "";
    hero.classList.toggle("pl-hero-group", mode === "group");
    hero.classList.toggle("hero-compact", mode === "story");
    hero.classList.toggle("has-art", !!g);
    art.hidden = !g;
    if (g) art.src = artUrl(g, "wide");
    if (mode === "group") {
      head.innerHTML = '<div class="pl-hero-text"><p class="pl-back-all"><a href="./" data-ig="">&larr; All of Pulse</a></p>' +
        '<p class="sfr-sub01 eyebrow pl-eyebrow-ig">' + icon(IG[g][1]) + "Pulse · Innovation Group</p>" +
        "<h1>" + esc(IG[g][0]) + '</h1><p class="lead">' + esc(IG[g][3]) + "</p></div>";
    } else if (mode === "story") {
      head.innerHTML = '<div class="pl-hero-text"><p class="sfr-sub01 eyebrow pl-eyebrow-ig">' + (g ? icon(IG[g][1]) : "") +
        "Pulse" + (g ? " · " + esc(IG[g][0]) : "") + "</p></div>";
    } else {
      head.innerHTML = heroHead;
    }
    box.hidden = mode === "story";
    box.innerHTML = mode === "story" ? "" : tiles().map(tileHtml).join("");
  }

  /* ------------------------------------------------------------------ feed */
  function sorted(list) {
    var l = list.slice();
    if (state.sort === "new") l.sort(function (a, b) { return a.added.slice(0, 10) < b.added.slice(0, 10) ? 1 : a.added.slice(0, 10) > b.added.slice(0, 10) ? -1 : sc(b) - sc(a); });
    else if (state.sort === "votes") l.sort(function (a, b) { return (b.votes || 0) - (a.votes || 0) || sc(b) - sc(a) || (a.added < b.added ? 1 : -1); });
    return l;   // "rel": the server's order (score, then newest)
  }
  function matches(s) {
    if (state.scope !== "all" && s.scope !== state.scope) return false;
    if (state.ig && (s.igs || []).indexOf(state.ig) < 0) return false;
    if (state.q) {
      var hay = (s.title + " " + s.summary + " " + s.source + " " + igsOf(s).map(function (g) { return IG[g][0]; }).join(" ")).toLowerCase();
      if (hay.indexOf(state.q) < 0) return false;
    }
    return true;
  }
  function pickLead(list, skip) {   // the most relevant story of the last three days, newest first
    var recent = list.filter(function (s) { return dayDiff(s.added) <= 3 && !skip[s.id]; });
    recent.sort(function (a, b) { return sc(b) - sc(a) || (a.added < b.added ? 1 : -1); });
    return recent[0] || null;
  }
  function renderIgChips() {
    var n = {};
    data.stories.forEach(function (s) { igsOf(s).forEach(function (g) { n[g] = (n[g] || 0) + 1; }); });
    var keys = Object.keys(n).sort(function (a, b) { return n[b] - n[a]; });
    var box = $("#pl-igs");
    box.innerHTML = '<button type="button" class="chip' + (state.ig ? "" : " is-on") + '" data-ig="" aria-pressed="' + (!state.ig) + '">All Innovation Groups</button>' +
      keys.map(function (g) {
        var on = state.ig === g;
        return '<button type="button" class="chip' + (on ? " is-on" : "") + '" data-ig="' + g + '" aria-pressed="' + on + '">' + esc(IG[g][0]) + "</button>";
      }).join("");
    box.hidden = !keys.length;
  }
  function rowsHtml(list, byWeek) {
    if (!list.length) return "";
    if (!byWeek) return '<section class="pl-week">' + list.map(rowHtml).join("") + "</section>";
    var heads = ["This week", "Last week", "Earlier"], groups = [[], [], []];
    list.forEach(function (s) { groups[week(s.added)].push(s); });
    return groups.map(function (g, w) {
      return g.length ? '<section class="pl-week"><h2 class="section-head pl-week-head">' + heads[w] + "</h2>" + g.map(rowHtml).join("") + "</section>" : "";
    }).join("");
  }
  function renderFeed() {
    used = {};
    renderHero(state.ig ? "group" : "feed");
    var list = sorted(data.stories.filter(matches));
    var pictures = !state.ig && !state.q;   // one group or a search: a text list, so no picture repeats
    var plain = !state.ig && !state.q && state.scope === "all" && state.sort === "new";
    var skip = {};
    if (plain) tiles().forEach(function (t) { if (t[1]) skip[t[1].id] = true; });
    var lead = plain ? pickLead(list, skip) : null;
    if (lead) skip[lead.id] = true;
    var grid = pictures ? list.filter(function (s) { return !plain || !skip[s.id]; }).slice(0, GRID) : [];
    var shown = {};
    if (lead) shown[lead.id] = true;
    grid.forEach(function (s) { shown[s.id] = true; });
    var rest = list.filter(function (s) { return !shown[s.id]; });
    $("#pl-lead").innerHTML = lead ? leadHtml(lead) : "";
    $("#pl-grid").innerHTML = grid.map(cardHtml).join("");
    var head = $("#pl-grid-head");
    head.hidden = !grid.length;
    head.textContent = plain ? "More this week" : state.sort === "votes" ? "Most useful" : state.sort === "rel" ? "Most relevant" : "Latest";
    $("#pl-list").innerHTML = rowsHtml(rest, state.sort === "new");
    $("#pl-empty").hidden = list.length > 0;
  }

  /* ------------------------------------------------------------------ one story */
  function renderStory(s) {
    used = {};
    renderHero("story", s);
    var reports = (s.sources || []).map(function (r) {
      return '<li class="deck"><span><a class="deck-title" href="' + esc(r.url) + '" rel="noopener" target="_blank">' + esc(r.title) + "</a>" +
        '<span class="muted pl-small"> · ' + esc(srcName(r.name)) + " · " + added(r.at).toLowerCase() + "</span></span>" +
        '<a class="btn btn-ghost btn-sm" href="' + esc(r.url) + '" rel="noopener" target="_blank">Open &#8599;</a></li>';
    }).join("");
    var igs = igsOf(s).map(function (g) { return IG[g][0]; });
    $("#pl-story").innerHTML =
      '<p class="pl-back"><a href="./" data-back>&larr; Back to Pulse</a></p>' +
      '<p class="item-meta">' + (SCOPE[s.scope] ? SCOPE[s.scope] + " · " : "") + meta(s) + ' · <span class="pl-added">' + added(s.added) + "</span></p>" +
      '<h2 class="pl-story-title">' + esc(s.title) + "</h2>" +
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
    } else if (body && body.detail === "members_only") {
      var join = ($("#pulse") && $("#pulse").dataset.membership) || "https://www.swissfoodresearch.ch/en/membership-benefits/";
      note(signedIn ? 'Pulse is for Swiss Food Research members. Your email address does not belong to a member organisation. ' +
                      '<a href="' + join + '" target="_blank" rel="noopener">Become a member</a>'
                    : 'Pulse is for Swiss Food Research members. <a href="#" data-pl-signin>Sign in</a> with your work email, or ' +
                      '<a href="' + join + '" target="_blank" rel="noopener">become a member</a>.', true);
    } else if (status === 404) {
      note('This story is no longer in Pulse. <a href="./" data-back>Back to Pulse</a>', true);
    } else {
      note("Pulse could not be loaded. Please try again later.");
    }
  }
  function param(k) { return new URLSearchParams(location.search).get(k); }
  function feedHref() { return location.pathname + (state.ig ? "?g=" + encodeURIComponent(state.ig) : ""); }
  function showFeed() {
    $("#pl-story").hidden = true; $("#pl-feed").hidden = false;
    $("#pl-filters").hidden = false;
    renderIgChips(); renderFeed();
    document.title = (state.ig ? IG[state.ig][0] + " | " : "") + "Pulse | Swiss Food Research";
  }
  function show() {
    var id = param("s"), g = param("g");
    state.ig = g && IG[g] ? g : "";
    if (!id && data) { showFeed(); window.scrollTo(0, 0); return; }   // stories already loaded
    note("Loading Pulse…");
    var url = FN + (id ? "?item=" + encodeURIComponent(id) : "?days=14");
    fetch(url, { headers: headers() }).then(function (r) {
      return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
    }).then(function (res) {
      if (!res.ok) { closed(res.status, res.body); return; }
      can = !!res.body.can_vote;
      if (id) {
        $("#pl-feed").hidden = true; $("#pl-story").hidden = false;
        renderStory(res.body.stories[0]);
      } else {
        data = res.body;
        showFeed();
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
        ((data && data.stories) || []).forEach(function (s) { if (s.id === id) { s.votes = res.body.votes; s.mine = res.body.mine; } });
        $$('[data-vote="' + id + '"]').forEach(function (b) {
          b.classList.toggle("is-on", res.body.mine);
          b.setAttribute("aria-pressed", res.body.mine ? "true" : "false");
          b.innerHTML = (res.body.mine ? "Marked useful" : "Useful") + ' <span class="pl-n">' + res.body.votes + "</span>";
        });
      })
      .catch(function () { btn.disabled = false; });
  }

  /* ------------------------------------------------------------------ events */
  function setIg(g) {
    state.ig = g && IG[g] ? g : "";
    history.replaceState({}, "", feedHref());
    if (!data) { go(feedHref()); return; }
    if (!$("#pl-story").hidden) { showFeed(); }
    else { renderIgChips(); renderFeed(); document.title = (state.ig ? IG[state.ig][0] + " | " : "") + "Pulse | Swiss Food Research"; }
    var top = $("#pl-hero"); if (top && top.scrollIntoView) window.scrollTo(0, 0);
  }
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-open],[data-back],[data-vote],[data-pl-signin],[data-scope],[data-ig]");
    if (!t || !(root.contains(t) || $("#pl-hero").contains(t))) return;
    if (t.hasAttribute("data-vote")) { e.preventDefault(); e.stopPropagation(); vote(t.getAttribute("data-vote"), t); }
    else if (t.hasAttribute("data-open")) { e.preventDefault(); go("?s=" + encodeURIComponent(t.getAttribute("data-open"))); }
    else if (t.hasAttribute("data-back")) { e.preventDefault(); go(feedHref()); }
    else if (t.hasAttribute("data-pl-signin")) { e.preventDefault(); if (window.SFR) window.SFR.openDialog(); }
    else if (t.hasAttribute("data-scope")) {
      state.scope = t.getAttribute("data-scope");
      $$("[data-scope]").forEach(function (c) { var on = c === t; c.classList.toggle("is-on", on); c.setAttribute("aria-pressed", on); });
      renderFeed();
    } else if (t.hasAttribute("data-ig")) { e.preventDefault(); setIg(t.getAttribute("data-ig")); }
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
    if (changed) { started = true; data = null; show(); }
  }
  document.addEventListener("sfr:session", function (e) { start(e.detail.session, e.detail.access); });
  setTimeout(function () { if (!started) start(null, null); }, 4000);   // sign-in check did not answer
})();
