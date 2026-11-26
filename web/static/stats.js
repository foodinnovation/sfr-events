/* SFR hub: Statistics tab, for signed-in staff only. Reads aggregated counts from
   functions/v1/stats (which checks staff access itself) and draws them without any library. */
(function () {
  "use strict";
  var cfg = window.SFR_EVENTS || {};
  var FN = cfg.supabaseUrl + "/functions/v1/stats";
  var root = document.getElementById("stats");
  if (!root) return;
  var out = document.getElementById("stats-out");
  var note = document.getElementById("stats-note");
  var session = null, loaded = false;
  var adNames = {};
  try { adNames = JSON.parse(root.getAttribute("data-ad-names") || "{}"); } catch (e) { adNames = {}; }
  function adName(k) { return adNames[k] || k; }
  function svcAction(r) {
    if (r === "calendar-shown") return "1:1 calendar shown";
    var m = /^(question|service|cta|next): (.+)$/.exec(r || "");
    if (!m) return r;
    return { question: "Question chosen: ", service: "Service opened: ", cta: "Service button: ", next: "Next step: " }[m[1]] + m[2];
  }
  var HOME = { "hero-book": "Hero: Book a free 1:1", "hero-events": "Hero: See upcoming events", "all-events": "All events",
    "register": "Register (next events)", "event": "Event details (next events)", "pulse": "More in Pulse",
    "pulse-story": "Pulse story", "calendar-shown": "1:1 calendar shown", "calendly-tab": "Open in Calendly",
    "radicle-open": "Open Radicle", "radicle-member": "Radicle: Become a member", "newsletter": "Newsletter: Subscribe", "services": "Browse all services" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmt(n) { return Number(n || 0).toLocaleString("de-CH"); }
  function pct(a, b) { return b ? Math.round((100 * a) / b) + "%" : "–"; }
  function iso(d) { return d.toISOString().slice(0, 10); }

  function period() {
    var sel = document.getElementById("st-period").value;
    var to = new Date(), from = new Date();
    if (sel === "custom") {
      return { from: document.getElementById("st-from").value, to: document.getElementById("st-to").value };
    }
    from.setDate(to.getDate() - (parseInt(sel, 10) - 1));
    return { from: iso(from), to: iso(to) };
  }

  function table(title, cols, rows, empty) {
    var h = '<section class="st-card"><h3 class="st-h">' + esc(title) + "</h3>";
    if (!rows.length) return h + '<p class="muted">' + esc(empty || "Nothing recorded in this period.") + "</p></section>";
    h += '<table class="st-table"><thead><tr>' + cols.map(function (c) {
      return '<th' + (c.num ? ' class="num"' : "") + ">" + esc(c.label) + "</th>";
    }).join("") + "</tr></thead><tbody>";
    rows.forEach(function (r) {
      h += "<tr>" + cols.map(function (c) {
        var v = c.get(r);
        return "<td" + (c.num ? ' class="num"' : "") + ">" + (c.html ? v : esc(v)) + "</td>";
      }).join("") + "</tr>";
    });
    return h + "</tbody></table></section>";
  }

  var TOOL = { radicle_topics: "Topic list", radicle_topic: "Topic article", radicle_search: "Search",
    radicle_project: "Project", radicle_funding_programmes: "Funding programmes" };

  function render(d) {
    var t = d.totals || {};
    var pl = d.pulse || {};
    var cx = d.connector || {};
    var kpis = [
      ["Page views", fmt(t.views)],
      ["Register clicks", fmt(t.registers)],
      ["Ad clicks", fmt(t.ad_clicks)],
      ["Email button clicks", fmt(t.mail_clicks)],
      ["Radicle – Knowledge actions", fmt(t.knowledge)],
      ["Pulse stories opened", fmt(pl.stories)]
    ];
    var max = Math.max.apply(null, (d.daily || []).map(function (x) { return x.views; }).concat([1]));
    var bars = (d.daily || []).map(function (x) {
      var h = Math.round((x.views / max) * 100);
      return '<div class="st-bar" title="' + esc(x.day + ": " + x.views + " views") + '"><span style="height:' + h + '%"></span></div>';
    }).join("");
    var roleTotal = (d.roles || []).reduce(function (a, r) { return a + r.views; }, 0);
    var dev = d.devices || {};
    var kn = d.knowledge || {};
    var sum = function (list, k) { return (list || []).reduce(function (a, r) { return a + (r[k] || 0); }, 0); };
    var dl = function (items) {
      return '<dl class="st-dl">' + items.map(function (i) { return "<div><dt>" + esc(i[0]) + "</dt><dd>" + fmt(i[1]) + "</dd></div>"; }).join("") + "</dl>";
    };
    var card = function (title, inner) { return '<section class="st-card"><h3 class="st-h">' + esc(title) + "</h3>" + inner + "</section>"; };
    var two = function (parts) { return '<div class="st-two">' + parts.join("") + "</div>"; };

    var sections = [
      ["events", "Events", fmt(sum(d.events, "views")) + " event page views · " + fmt(t.registers) + " register clicks",
        table("Interest and registrations", [
          { label: "Event", html: true, get: function (r) {
            return r.slug && r.slug !== "null" ? '<a href="../events/' + encodeURIComponent(r.slug) + '/">' + esc(r.title) + "</a>" : esc(r.title);
          } },
          { label: "Date", get: function (r) { return r.date || ""; } },
          { label: "Views", num: true, get: function (r) { return fmt(r.views); } },
          { label: "Register clicks", num: true, get: function (r) { return fmt(r.registers); } },
          { label: "Click rate", num: true, get: function (r) { return pct(r.registers, r.views); } }
        ], d.events || []) +
        two([
          table("Ads on the events list", [
            { label: "Ad", get: function (r) { return adName(r.ad); } },
            { label: "Shown", num: true, get: function (r) { return fmt(r.shown); } },
            { label: "Clicks", num: true, get: function (r) { return fmt(r.clicks); } },
            { label: "Click rate", num: true, get: function (r) { return pct(r.clicks, r.shown); } }
          ], d.ads || []),
          table("Email buttons", [
            { label: "Button", get: function (r) {
              var b = String(r.button || "");
              return b.indexOf("ad: ") === 0 ? "Ad: " + adName(b.slice(4)) : b.charAt(0).toUpperCase() + b.slice(1);
            } },
            { label: "Clicks", num: true, get: function (r) { return fmt(r.clicks); } }
          ], d.mail || []),
          table("Searches", [
            { label: "Search term", get: function (r) { return r.term; } },
            { label: "Times", num: true, get: function (r) { return fmt(r.n); } }
          ], d.searches || []),
          table("Filters used", [
            { label: "Filter", get: function (r) { return r.filter; } },
            { label: "Times", num: true, get: function (r) { return fmt(r.n); } }
          ], d.filters || [])
        ])],
      ["pulse", "Pulse", fmt(pl.views) + " page views · " + fmt(pl.stories) + " stories opened",
        two([
          card("Use", dl([["Pulse page views", pl.views], ["Stories opened", pl.stories], ["Clicks to original reports", pl.originals],
            ["Useful votes", pl.votes], ["Clicks from the home page", pl.from_home]])),
          table("Sources followed", [
            { label: "Website", get: function (r) { return r.outlet || "(unknown)"; } },
            { label: "Clicks", num: true, get: function (r) { return fmt(r.clicks); } }
          ], pl.outlets || [], "No clicks to original reports in this period.")
        ]) +
        table("Stories", [
          { label: "Story", html: true, get: function (r) {
            return '<a href="../pulse/?s=' + encodeURIComponent(r.id) + '">' + esc(r.title || "(title not recorded)") + "</a>";
          } },
          { label: "Opened", num: true, get: function (r) { return fmt(r.opened); } },
          { label: "Clicks to originals", num: true, get: function (r) { return fmt(r.originals); } },
          { label: "Useful votes", num: true, get: function (r) { return fmt(r.votes); } }
        ], pl.stories_top || [], "No Pulse story opened, followed or voted on in this period.") +
        two([
          table("Filters used", [
            { label: "Filter", get: function (r) { return r.filter; } },
            { label: "Times", num: true, get: function (r) { return fmt(r.n); } }
          ], pl.filters || []),
          table("Searches", [
            { label: "Search term", get: function (r) { return r.term; } },
            { label: "Times", num: true, get: function (r) { return fmt(r.n); } }
          ], pl.searches || [])
        ])],
      ["pages", "Home page and Services", fmt(sum(d.home, "clicks")) + " home page clicks · " + fmt(sum(d.services, "clicks")) + " Services clicks",
        two([
          table("Home page", [
            { label: "Button", get: function (r) { return HOME[r.button] || r.button; } },
            { label: "Clicks", num: true, get: function (r) { return fmt(r.clicks); } }
          ], d.home || [], "No clicks on the home page in this period."),
          table("Services page", [
            { label: "Action", get: function (r) { return svcAction(r.action); } },
            { label: "Clicks", num: true, get: function (r) { return fmt(r.clicks); } }
          ], d.services || [], "No clicks on the Services page in this period.")
        ])],
      ["knowledge", "Radicle – Knowledge", fmt(t.knowledge) + " actions",
        two([
          card("Use", dl([["Topics opened", kn.topics_opened], ["Quick searches", kn.searches], ["Funding Finder runs", kn.finder_runs]])),
          table("Topics opened", [
            { label: "Topic", get: function (r) { return r.label; } },
            { label: "Opened", num: true, get: function (r) { return fmt(r.n); } }
          ], kn.topics || [])
        ])],
      ["connector", "Radicle connector", fmt(cx.calls) + " calls · " + fmt(cx.people) + " people · " + fmt(cx.organisations) + " organisations",
        two([
          card("Use", dl([["Calls", cx.calls], ["People", cx.people], ["Organisations", cx.organisations],
            ["New connections", cx.connections], ["Stopped at the daily limit", cx.limit_hits], ["Refused (no access)", cx.refused]])),
          table("Tools", [
            { label: "Tool", get: function (r) { return TOOL[r.tool] || r.tool; } },
            { label: "Calls", num: true, get: function (r) { return fmt(r.calls); } }
          ], cx.tools || [], "No calls in this period.")
        ]) +
        table("Organisations", [
          { label: "Organisation", get: function (r) { return r.organisation; } },
          { label: "People", num: true, get: function (r) { return fmt(r.people); } },
          { label: "Calls", num: true, get: function (r) { return fmt(r.calls); } }
        ], cx.organisations_top || [], "No calls in this period.")],
      ["audience", "Audience", fmt(dev.desktop) + " desktop · " + fmt(dev.mobile) + " mobile",
        two([
          table("Views by role", [
            { label: "Role", get: function (r) { return { visitor: "Visitor (not signed in)", participant: "Participant", member: "Member", staff: "Staff" }[r.role] || r.role; } },
            { label: "Views", num: true, get: function (r) { return fmt(r.views); } },
            { label: "Share", num: true, get: function (r) { return pct(r.views, roleTotal); } }
          ], d.roles || []),
          table("Where visitors came from", [
            { label: "Website", get: function (r) { return r.source; } },
            { label: "Views", num: true, get: function (r) { return fmt(r.views); } }
          ], d.sources || [], "No visits from other websites in this period."),
          card("Devices", dl([["Desktop", dev.desktop], ["Mobile", dev.mobile]]))
        ])]
    ];
    var open = {};   // keep open sections open when the period changes
    Array.prototype.forEach.call(out.querySelectorAll("details[data-sec]"), function (x) { open[x.getAttribute("data-sec")] = x.open; });

    var outline = '<nav class="st-outline" aria-label="Sections"><p class="st-outline-h">On this page</p><ul>' +
      '<li><a href="#st-overview" data-goto="">Overview</a></li>' +
      sections.map(function (x) {
        return '<li><a href="#st-sec-' + x[0] + '" data-goto="' + x[0] + '"' + (open[x[0]] ? ' class="is-open"' : "") + ">" + esc(x[1]) + "</a></li>";
      }).join("") + '</ul><p class="st-outline-act"><button type="button" class="st-link" data-fold="open">Expand all</button>' +
      '<button type="button" class="st-link" data-fold="close">Collapse all</button></p></nav>';
    var html =
      '<div class="st-layout">' + outline + '<div class="st-main">' +
      '<section id="st-overview" class="st-overview"><div class="st-kpis">' + kpis.map(function (k) {
        return '<div class="st-kpi"><span class="st-num">' + k[1] + '</span><span class="st-lab">' + esc(k[0]) + "</span></div>";
      }).join("") + "</div>" +
      '<h2 class="st-h st-h-chart">Page views per day</h2><div class="st-chart">' + bars +
      '</div><p class="st-axis"><span>' + esc(d.from) + "</span><span>" + esc(d.to) + "</span></p></section>" +
      sections.map(function (x) {
        return '<details class="st-sec" id="st-sec-' + x[0] + '" data-sec="' + x[0] + '"' + (open[x[0]] ? " open" : "") + ">" +
          '<summary><h2 class="st-sec-h">' + esc(x[1]) + '</h2><span class="st-sec-hint">' + esc(x[2]) + "</span></summary>" +
          '<div class="st-sec-body">' + x[3] + "</div></details>";
      }).join("") + "</div></div>";
    out.innerHTML = html;
  }

  function load() {
    if (!session) return;
    var p = period();
    if (!p.from || !p.to) return;
    note.textContent = "Loading …";
    fetch(FN + "?from=" + p.from + "&to=" + p.to, { headers: { Authorization: "Bearer " + session.access_token } })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.status === 403) { note.textContent = "Statistics are for Swiss Food Research staff."; out.innerHTML = ""; return; }
        if (res.status !== 200) { note.textContent = "The statistics could not be loaded. Try again in a moment."; return; }
        note.textContent = "Counted without cookies or personal data. Counts older than 13 months are deleted.";
        render(res.body);
      })
      .catch(function () { note.textContent = "The statistics could not be loaded. Try again in a moment."; });
  }

  function onSession(s) {
    session = s;
    if (!s) { out.innerHTML = ""; note.textContent = "Sign in with your Swiss Food Research address to see the statistics."; return; }
    if (!loaded) { loaded = true; load(); }
  }

  /* outline: jump to a section and open it; fold or unfold everything; mark open sections */
  function syncOutline() {
    Array.prototype.forEach.call(out.querySelectorAll("details[data-sec]"), function (x) {
      var l = out.querySelector('[data-goto="' + x.getAttribute("data-sec") + '"]');
      if (l) l.classList.toggle("is-open", x.open);
    });
  }
  out.addEventListener("toggle", syncOutline, true);
  out.addEventListener("click", function (e) {
    var g = e.target.closest("[data-goto]"), f = e.target.closest("[data-fold]");
    if (g) {
      e.preventDefault();
      var key = g.getAttribute("data-goto");
      var target = key ? document.getElementById("st-sec-" + key) : document.getElementById("st-overview");
      if (!target) return;
      if (key) target.open = true;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (f) {
      var on = f.getAttribute("data-fold") === "open";
      Array.prototype.forEach.call(out.querySelectorAll("details[data-sec]"), function (x) { x.open = on; });
    }
  });

  var sel = document.getElementById("st-period");
  sel.addEventListener("change", function () {
    document.getElementById("st-custom").hidden = sel.value !== "custom";
    if (sel.value !== "custom") load();
  });
  document.getElementById("st-apply").addEventListener("click", load);
  document.getElementById("st-to").value = iso(new Date());
  document.getElementById("st-from").value = iso(new Date(Date.now() - 29 * 86400000));

  document.addEventListener("sfr:session", function (e) {
    var s = e.detail.session;
    var same = s && session && s.user && session.user && s.user.id === session.user.id;
    if (!same) { loaded = false; onSession(s); }
  });
  if (window.SFR && window.SFR.sb) window.SFR.sb.auth.getSession().then(function (r) { if (!loaded) onSession(r.data.session); });
  else onSession(null);
})();
