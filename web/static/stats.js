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
    var h = '<section class="st-card"><h2 class="st-h">' + esc(title) + "</h2>";
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

  function render(d) {
    var t = d.totals || {};
    var kpis = [
      ["Page views", fmt(t.views)],
      ["Register clicks", fmt(t.registers)],
      ["Ad clicks", fmt(t.ad_clicks)],
      ["Email button clicks", fmt(t.mail_clicks)],
      ["Radicle – Knowledge actions", fmt(t.knowledge)]
    ];
    var max = Math.max.apply(null, (d.daily || []).map(function (x) { return x.views; }).concat([1]));
    var bars = (d.daily || []).map(function (x) {
      var h = Math.round((x.views / max) * 100);
      return '<div class="st-bar" title="' + esc(x.day + ": " + x.views + " views") + '"><span style="height:' + h + '%"></span></div>';
    }).join("");
    var roleTotal = (d.roles || []).reduce(function (a, r) { return a + r.views; }, 0);
    var dev = d.devices || {};
    var html =
      '<div class="st-kpis">' + kpis.map(function (k) {
        return '<div class="st-kpi"><span class="st-num">' + k[1] + '</span><span class="st-lab">' + esc(k[0]) + "</span></div>";
      }).join("") + "</div>" +
      '<section class="st-card"><h2 class="st-h">Page views per day</h2><div class="st-chart">' + bars +
      '</div><p class="st-axis"><span>' + esc(d.from) + "</span><span>" + esc(d.to) + "</span></p></section>" +
      table("Events: interest and registrations", [
        { label: "Event", html: true, get: function (r) {
          return r.slug && r.slug !== "null" ? '<a href="../events/' + encodeURIComponent(r.slug) + '/">' + esc(r.title) + "</a>" : esc(r.title);
        } },
        { label: "Date", get: function (r) { return r.date || ""; } },
        { label: "Views", num: true, get: function (r) { return fmt(r.views); } },
        { label: "Register clicks", num: true, get: function (r) { return fmt(r.registers); } },
        { label: "Click rate", num: true, get: function (r) { return pct(r.registers, r.views); } }
      ], d.events || []) +
      '<div class="st-two">' +
      table("Ads on the events list", [
        { label: "Ad", get: function (r) { return adName(r.ad); } },
        { label: "Shown", num: true, get: function (r) { return fmt(r.shown); } },
        { label: "Clicks", num: true, get: function (r) { return fmt(r.clicks); } },
        { label: "Click rate", num: true, get: function (r) { return pct(r.clicks, r.shown); } }
      ], d.ads || []) +
      table("Email buttons", [
        { label: "Button", get: function (r) {
          var b = String(r.button || "");
          return b.indexOf("ad: ") === 0 ? "Ad: " + adName(b.slice(4)) : b.charAt(0).toUpperCase() + b.slice(1);
        } },
        { label: "Clicks", num: true, get: function (r) { return fmt(r.clicks); } }
      ], d.mail || []) +
      table("Searches on the events list", [
        { label: "Search term", get: function (r) { return r.term; } },
        { label: "Times", num: true, get: function (r) { return fmt(r.n); } }
      ], d.searches || []) +
      table("Filters used", [
        { label: "Filter", get: function (r) { return r.filter; } },
        { label: "Times", num: true, get: function (r) { return fmt(r.n); } }
      ], d.filters || []) +
      table("Radicle – Knowledge: topics opened", [
        { label: "Topic", get: function (r) { return r.label; } },
        { label: "Opened", num: true, get: function (r) { return fmt(r.n); } }
      ], (d.knowledge && d.knowledge.topics) || []) +
      '<section class="st-card"><h2 class="st-h">Radicle – Knowledge: use</h2><dl class="st-dl">' +
        "<div><dt>Topics opened</dt><dd>" + fmt(d.knowledge && d.knowledge.topics_opened) + "</dd></div>" +
        "<div><dt>Quick searches</dt><dd>" + fmt(d.knowledge && d.knowledge.searches) + "</dd></div>" +
        "<div><dt>Funding Finder runs</dt><dd>" + fmt(d.knowledge && d.knowledge.finder_runs) + "</dd></div></dl></section>" +
      table("Views by role", [
        { label: "Role", get: function (r) { return { visitor: "Visitor (not signed in)", participant: "Participant", member: "Member", staff: "Staff" }[r.role] || r.role; } },
        { label: "Views", num: true, get: function (r) { return fmt(r.views); } },
        { label: "Share", num: true, get: function (r) { return pct(r.views, roleTotal); } }
      ], d.roles || []) +
      table("Where visitors came from", [
        { label: "Website", get: function (r) { return r.source; } },
        { label: "Views", num: true, get: function (r) { return fmt(r.views); } }
      ], d.sources || [], "No visits from other websites in this period.") +
      '<section class="st-card"><h2 class="st-h">Devices</h2><dl class="st-dl">' +
        "<div><dt>Desktop</dt><dd>" + fmt(dev.desktop) + "</dd></div>" +
        "<div><dt>Mobile</dt><dd>" + fmt(dev.mobile) + "</dd></div></dl></section>" +
      "</div>";
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
