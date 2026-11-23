/* Radicle – Knowledge: the hub's members-only knowledge tab.
   Content comes from functions/v1/knowledge after sign-in; nothing of it is in the static site.
   Views (shareable addresses):  ./            topics and search
                                 ?q=...        search results
                                 ?topic=slug   one topic article
                                 ?project=id   one project
                                 ?finder=1     funding finder                                  */
(function () {
  "use strict";
  var cfg = window.SFR_EVENTS || {};
  var FN = cfg.supabaseUrl + "/functions/v1/knowledge";
  var COACHING = "https://www.swissfoodresearch.ch/de/agro-food-innovations-services/coaching/";
  var root = document.getElementById("kn");
  if (!root) return;

  var session = null, topicsCache = null, seq = 0;

  /* ------------------------------------------------------------------ helpers */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function label(slug) { return String(slug || "").replace(/_/g, " ").replace(/^\w/, function (c) { return c.toUpperCase(); }); }
  function years(p) {
    var a = (p.start_date || "").slice(0, 4), b = (p.end_date || "").slice(0, 4);
    return a && b && a !== b ? a + "–" + b : a || b || "";
  }
  function chf(v) {
    var n = Number(v); if (!n) return "";
    return "CHF " + (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + " m" : Math.round(n / 1000) + "k");
  }
  var SOURCE = { snf: "SNF", aramis: "ARAMIS", regiosuisse: "Regiosuisse" };
  function href(params) {
    var u = new URLSearchParams(params || {}).toString();
    return location.pathname + (u ? "?" + u : "");
  }
  function navLink(params, text, cls) {
    return '<a data-nav href="' + esc(href(params)) + '"' + (cls ? ' class="' + cls + '"' : "") + ">" + text + "</a>";
  }

  /* Small, safe Markdown: everything is escaped first, then a few constructs are re-enabled. */
  function inline(t) {
    return t
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener" target="_blank">$1</a>')
      .replace(/#((?:aramis|snf|regiosuisse):[A-Za-z0-9_-]+)/g, function (_, id) {
        return '<a data-nav class="ref" href="' + esc(href({ project: id })) + '">' + id + "</a>";
      });
  }
  function markdown(md) {
    var out = [], para = [], list = null;
    function flush() {
      if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; }
      if (list) { out.push("</" + list + ">"); list = null; }
    }
    esc(md).split(/\r?\n/).forEach(function (line) {
      var m;
      if (!line.trim()) { flush(); return; }
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        flush();
        var lvl = Math.min(5, Math.max(3, m[1].length + 1));
        out.push("<h" + lvl + ">" + inline(m[2]) + "</h" + lvl + ">");
        return;
      }
      if ((m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/))) {
        var kind = /^\s*\d+\./.test(line) ? "ol" : "ul";
        if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; }
        if (list !== kind) { if (list) out.push("</" + list + ">"); out.push("<" + kind + ">"); list = kind; }
        out.push("<li>" + inline(m[1]) + "</li>");
        return;
      }
      if (list) { out.push("</" + list + ">"); list = null; }
      para.push(line.trim());
    });
    flush();
    return out.join("\n");
  }

  function api(params, body) {
    var url = FN + "?" + new URLSearchParams(params).toString();
    var opts = { headers: { Authorization: "Bearer " + session.access_token } };
    if (body) { opts.method = "POST"; opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b }; });
    });
  }

  function show(html) { root.innerHTML = html; }
  function failed(res) {
    if (res && res.status === 403) return gate("member");
    if (res && res.status === 401) return gate("signin");
    show('<p class="form-message error">This could not be loaded. Please try again in a moment.</p>');
  }

  /* ------------------------------------------------------------------ gate */
  function gate(kind) {
    if (kind === "member") {
      show('<section class="kn-gate"><h2 class="h4">For members of Swiss Food Research</h2>' +
        "<p>You are signed in as <strong>" + esc(session && session.user.email) + "</strong>, which is not a member " +
        "address. Radicle – Knowledge is open to everyone at a member organisation: sign in with your work " +
        "address there.</p><p class=\"muted\">Questions: <a href=\"mailto:contact@swissfoodresearch.ch\">" +
        "contact@swissfoodresearch.ch</a></p></section>");
      return;
    }
    show('<section class="kn-gate"><h2 class="h4">Sign in to open Radicle – Knowledge</h2>' +
      "<p>Topic articles on Swiss agro-food research, about 6,600 funded projects from ARAMIS, SNF and " +
      "Regiosuisse, and a funding finder for your project idea. Open to everyone at a member organisation " +
      "of Swiss Food Research.</p>" +
      '<button class="btn btn-primary" type="button" id="kn-signin">Sign in</button></section>');
    document.getElementById("kn-signin").addEventListener("click", function () { window.SFR.openDialog(); });
  }

  /* ------------------------------------------------------------------ views */
  function searchForm(q) {
    return '<form class="kn-search" role="search" id="kn-search">' +
      '<label class="visually-hidden" for="kn-q">Search topics and projects</label>' +
      '<input id="kn-q" type="search" placeholder="Search topics and projects, e.g. footrot, upcycling, Agroscope" value="' + esc(q || "") + '">' +
      '<button class="btn btn-primary" type="submit">Search</button>' +
      navLink({ finder: 1 }, "Funding finder", "btn btn-secondary") + "</form>";
  }
  function bindSearch() {
    var f = document.getElementById("kn-search");
    if (f) f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var q = document.getElementById("kn-q").value.trim();
      go(q ? { q: q } : {});
    });
  }
  function crumbs(parts) {
    return '<p class="crumbs kn-crumbs">' + navLink({}, "All topics") + (parts || "") + "</p>";
  }

  function viewHome(my) {
    var load = topicsCache ? Promise.resolve({ status: 200, body: topicsCache }) : api({ topics: 1 });
    return load.then(function (res) {
      if (my !== seq) return;
      if (res.status !== 200) return failed(res);
      topicsCache = res.body;
      var heads = {}, groups = {};
      res.body.topics.forEach(function (t) { if (!t.parent) heads[t.slug] = t; });
      res.body.topics.forEach(function (t) {
        var key = t.parent || t.slug;
        (groups[key] = groups[key] || []).push(t);
      });
      var keys = Object.keys(groups).sort(function (a, b) {
        return (heads[a] ? heads[a].label : label(a)).localeCompare(heads[b] ? heads[b].label : label(b));
      });
      var html = searchForm() +
        '<p class="muted kn-stats">' + res.body.topics.length + " topic articles · " +
        Number(res.body.projects).toLocaleString("en-GB") + " funded projects" +
        (res.body.compiled ? " · compiled " + esc(String(res.body.compiled).slice(0, 10)) : "") + "</p>" +
        '<div class="kn-groups">' + keys.map(function (k) {
          var items = groups[k].sort(function (a, b) {
            return (a.slug === k ? -1 : b.slug === k ? 1 : a.label.localeCompare(b.label));
          });
          return '<section class="kn-group"><h2 class="kn-group-head">' + esc(heads[k] ? heads[k].label : label(k)) + "</h2><ul>" +
            items.map(function (t) {
              var n = (t.active || 0) + (t.completed || 0);
              return "<li>" + navLink({ topic: t.slug }, esc(t.slug === k ? "Overview" : t.label)) +
                (n ? ' <span class="kn-count">' + n + "</span>" : "") + "</li>";
            }).join("") + "</ul></section>";
        }).join("") + "</div>";
      show(html); bindSearch();
    });
  }

  function projectRow(p) {
    var meta = [p.funder, years(p), p.institution, chf(p.budget_chf)].filter(Boolean).map(esc).join(" · ");
    return '<li class="kn-project">' + navLink({ project: p.id }, esc(p.title), "kn-project-title") +
      (p.active ? ' <span class="tag">Active</span>' : "") +
      (meta ? '<span class="kn-meta">' + meta + "</span>" : "") +
      (p.snippet ? '<span class="kn-snippet">' + esc(p.snippet) + (p.snippet.length >= 260 ? " ..." : "") + "</span>" : "") +
      "</li>";
  }

  function viewSearch(my, q) {
    show(searchForm(q) + '<p class="muted">Searching ...</p>'); bindSearch();
    return api({ q: q }).then(function (res) {
      if (my !== seq) return;
      if (res.status !== 200) return failed(res);
      var t = res.body.topics || [], p = res.body.projects || [];
      show(searchForm(q) + crumbs(" / Search") +
        (!t.length && !p.length ? "<p>Nothing found for <strong>" + esc(q) + "</strong>. Try fewer or broader words.</p>" : "") +
        (t.length ? '<h2 class="h4">Topics</h2><ul class="kn-topic-hits">' + t.map(function (x) {
          return "<li>" + navLink({ topic: x.slug }, esc(x.label)) + ' <span class="muted">' + esc(x.title) + "</span></li>";
        }).join("") + "</ul>" : "") +
        (p.length ? '<h2 class="h4">Projects</h2><ul class="kn-projects">' + p.map(projectRow).join("") + "</ul>" +
          (p.length >= 40 ? '<p class="muted">Showing the 40 best matches. Add words to narrow the search.</p>' : "") : ""));
      bindSearch();
    });
  }

  function contactCard(c) {
    if (!c) return "";
    return '<aside class="kn-contact"><p class="kn-contact-label">Your contact at Swiss Food Research</p>' +
      "<p><strong>" + esc(c.name) + "</strong><br>" + esc(c.role || "") + "</p>" +
      '<a class="btn btn-secondary btn-sm" href="' + COACHING + '" rel="noopener" target="_blank">Book a meeting</a></aside>';
  }

  function viewTopic(my, slug) {
    show(crumbs() + '<p class="muted">Loading ...</p>');
    return api({ topic: slug }).then(function (res) {
      if (my !== seq) return;
      if (res.status === 404) return show(crumbs() + "<p>This topic does not exist (any more).</p>");
      if (res.status !== 200) return failed(res);
      var a = res.body, ps = a.projects || [];
      var active = ps.filter(function (p) { return p.active; }), done = ps.filter(function (p) { return !p.active; });
      var trend = { increasing: "Funding increasing", decreasing: "Funding decreasing", stable: "Funding stable" }[a.trend] || "";
      document.title = a.label + " | Radicle – Knowledge";
      show(crumbs(a.parent ? " / " + esc(label(a.parent)) : "") +
        '<article class="kn-article"><header><h2>' + esc(a.title) + "</h2>" +
        '<p class="muted">' + [ps.length + " projects", active.length + " active", trend].filter(Boolean).join(" · ") + "</p></header>" +
        '<div class="kn-article-grid"><div class="kn-body">' +
        ((a.key_findings || []).length ? '<section class="kn-findings"><h3>Key findings</h3><ul>' +
          a.key_findings.map(function (f) { return "<li>" + inline(esc(f)) + "</li>"; }).join("") + "</ul></section>" : "") +
        markdown(a.body) + "</div>" +
        '<div class="kn-side">' + contactCard(a.contact) +
        ((a.related || []).length ? '<section class="kn-related"><h3 class="kn-contact-label">Related topics</h3><ul>' +
          a.related.map(function (r) { return "<li>" + navLink({ topic: r.slug }, esc(r.label)) + "</li>"; }).join("") + "</ul></section>" : "") +
        "</div></div>" +
        (active.length ? '<h3 class="kn-list-head">Active projects (' + active.length + ')</h3><ul class="kn-projects">' + active.map(projectRow).join("") + "</ul>" : "") +
        (done.length ? '<details class="kn-done"><summary>Completed projects (' + done.length + ')</summary><ul class="kn-projects">' +
          done.map(projectRow).join("") + "</ul></details>" : "") +
        "</article>");
      window.scrollTo(0, 0);
    });
  }

  function viewProject(my, id) {
    show(crumbs() + '<p class="muted">Loading ...</p>');
    return api({ project: id }).then(function (res) {
      if (my !== seq) return;
      if (res.status === 404) return show(crumbs() + "<p>This project is not in radicle (any more).</p>");
      if (res.status !== 200) return failed(res);
      var p = res.body;
      var facts = [["Source", SOURCE[p.source] || p.source], ["Funder", p.funder], ["Period", years(p)],
        ["Status", p.status], ["Budget", chf(p.budget_chf)], ["Institution", p.institution],
        ["Lead", p.lead], ["Industry partners", p.partners], ["Technology readiness", p.trl ? "TRL " + p.trl : ""]]
        .filter(function (f) { return f[1]; });
      show(crumbs(" / Project") + '<article class="kn-article"><header><p class="sfr-sub01 muted">' + esc(p.id) + "</p><h2>" + esc(p.title) + "</h2></header>" +
        '<div class="kn-article-grid"><div class="kn-body">' + (p.summary ? markdown(p.summary) : '<p class="muted">No summary available.</p>') +
        ((p.topics || []).length ? '<p class="kn-chips">' + p.topics.map(function (t) {
          return navLink({ topic: t.slug }, esc(t.label), "chip");
        }).join("") + "</p>" : "") + "</div>" +
        '<div class="kn-side"><dl class="facts">' + facts.map(function (f) {
          return "<div><dt>" + f[0] + "</dt><dd>" + esc(f[1]) + "</dd></div>";
        }).join("") + "</dl>" +
        (p.source_url && /^https?:\/\//.test(p.source_url) ? '<a class="btn btn-secondary btn-sm" href="' + esc(p.source_url) +
          '" rel="noopener" target="_blank">Open in ' + esc(SOURCE[p.source] || "source") + "</a>" : "") +
        "</div></div></article>");
      window.scrollTo(0, 0);
    });
  }

  function viewFinder(my) {
    show(crumbs(" / Funding finder") + '<section class="kn-finder"><h2 class="h4">Funding finder</h2>' +
      "<p>Describe your project idea in a few sentences. Radicle matches it against known research gaps in Swiss " +
      "agro-food research and the funding programmes Swiss Food Research tracks.</p>" +
      '<form id="kn-finder" class="stack"><label for="kn-idea">Your project idea</label>' +
      '<textarea id="kn-idea" rows="5" minlength="10" maxlength="4000" required placeholder="e.g. We want to turn whey from cheese making into a protein ingredient for sports drinks and need a pilot plant."></textarea>' +
      '<label class="kn-check"><input type="checkbox" id="kn-active" checked> Only programmes open in 2026</label>' +
      '<button class="btn btn-primary" type="submit">Find funding</button></form>' +
      '<div id="kn-finder-out" aria-live="polite"></div></section>');
    document.getElementById("kn-finder").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var out = document.getElementById("kn-finder-out");
      out.innerHTML = '<p class="muted">Matching ...</p>';
      api({ finder: 1 }, { idea: document.getElementById("kn-idea").value, active_only: document.getElementById("kn-active").checked })
        .then(function (res) {
          if (res.status !== 200) {
            out.innerHTML = '<p class="form-message error">' + (res.status === 400 ? "Please describe the idea in at least a sentence." : "This could not be loaded. Please try again.") + "</p>";
            return;
          }
          var r = res.body, tailored = r.instruments.filter(function (i) { return i.tailored; }),
            general = r.instruments.filter(function (i) { return !i.tailored; });
          function inst(i) {
            var meta = [i.funder, i.max_funding_chf ? "up to " + i.max_funding_chf : "", i.stage].filter(Boolean).map(esc).join(" · ");
            var link = i.link && /^https?:\/\//.test(i.link) ? i.link : "";
            return "<li><strong>" + (link ? '<a href="' + esc(link) + '" rel="noopener" target="_blank">' + esc(i.name) + "</a>" : esc(i.name)) +
              "</strong>" + (meta ? '<span class="kn-meta">' + meta + "</span>" : "") + "</li>";
          }
          out.innerHTML =
            '<div class="kn-finder-grid"><section><h3>Research gaps that fit</h3>' +
            (r.gaps.length ? '<ul class="kn-gaps">' + r.gaps.map(function (g) {
              return "<li><span class=\"kn-sev kn-sev-" + esc(g.severity) + '">Gap ' + esc(g.severity) + "/5</span> " +
                navLink({ topic: g.topic_slug }, esc(g.topic_label)) + "<p>" + esc(g.description) + "</p>" +
                (g.cost_range_chf ? '<span class="kn-meta">Estimated cost to close: ' + esc(g.cost_range_chf) + "</span>" : "") + "</li>";
            }).join("") + "</ul>" : '<p class="muted">No known research gap matches these words. Try describing the topic more broadly.</p>') +
            "</section><section><h3>Funding programmes</h3>" +
            (tailored.length ? '<p class="kn-contact-label">Matched to your idea</p><ul class="kn-inst">' + tailored.map(inst).join("") + "</ul>" : "") +
            (general.length ? '<p class="kn-contact-label">Broadly applicable</p><ul class="kn-inst">' + general.map(inst).join("") + "</ul>" : "") +
            (r.contacts.length ? r.contacts.map(contactCard).join("") : "") + "</section></div>";
        });
    });
  }

  /* ------------------------------------------------------------------ router */
  function render() {
    var done = route();
    if (done && done.catch) done.catch(function () { failed(null); });
  }
  function route() {
    var my = ++seq;
    if (!session) return gate("signin");
    var p = new URLSearchParams(location.search);
    document.title = "Radicle – Knowledge | Swiss Food Research";
    if (p.get("topic")) return viewTopic(my, p.get("topic"));
    if (p.get("project")) return viewProject(my, p.get("project"));
    if (p.get("finder")) return viewFinder(my);
    if (p.get("q")) return viewSearch(my, p.get("q"));
    return viewHome(my);
  }
  function go(params) { history.pushState(null, "", href(params)); render(); }

  document.addEventListener("click", function (ev) {
    var a = ev.target.closest && ev.target.closest("a[data-nav]");
    if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return;
    ev.preventDefault();
    history.pushState(null, "", a.getAttribute("href"));
    render(); window.scrollTo(0, 0);
  });
  window.addEventListener("popstate", render);
  document.addEventListener("sfr:session", function (ev) {
    var s = ev.detail.session;
    var changed = (s && s.user.id) !== (session && session.user.id);
    session = s;
    if (!s) topicsCache = null;
    if (changed || root.querySelector(".kn-loading")) render();
  });
  // the first announcement can come before this script runs (no stored session): ask directly too
  if (window.SFR && window.SFR.sb) {
    window.SFR.sb.auth.getSession().then(function (r) {
      if (root.querySelector(".kn-loading")) { session = r.data.session; render(); }
    });
  } else {
    gate("signin");
  }
})();
