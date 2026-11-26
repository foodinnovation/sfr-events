/* ============================================================
   Radicle – Knowledge in the SFR hub. Radicle's Obsidian-inspired wiki reader
   (foodinnovation/agro-food-intelligence, src/api/static/wiki/js/app.js), adapted:
   data comes from the hub's members-only function (functions/v1/knowledge, which speaks
   radicle's wiki API) with the hub's Supabase sign-in instead of radicle's cookie.
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.SFR_EVENTS || {};
  // the app takes the window height under the hub header (which is taller on phones)
  function fitHeader() {
    var h = document.querySelector('.site-header');
    if (h) document.documentElement.style.setProperty('--kn-header', h.offsetHeight + 'px');
  }
  fitHeader();
  window.addEventListener('resize', fitHeader);
  var FN = CFG.supabaseUrl + '/functions/v1/knowledge';
  var COACHING = 'https://www.swissfoodresearch.ch/de/agro-food-innovations-services/coaching/';
  var session = null;

  /* ---------------- state ---------------- */
  var state = {
    topics: [],            // list from /topics
    topicMap: {},          // slug -> topic list item
    tabs: [],              // [{slug, label}]
    activeSlug: null,      // slug of active tab, null = home
    articleCache: {},      // slug -> article json
    graphData: null,       // {nodes, links} from /graph
    graph: null,           // ForceGraph instance
    finder: { idea: '', activeOnly: true, minSev: 2, result: null, loading: false, instruments: null },
    graphLocal: true,   // default to the local neighbourhood — the full 242-node net is a hairball in a 300px pane
    graphHops: 1,       // local-mode radius: 1 = direct neighbours, 2 = neighbours-of-neighbours
    graphHover: null,   // node currently hovered (drives focus dimming)
    graphAdj: {},       // adjacency map id -> {neighbourId: true}, built once from links
    switcherOpen: false,
    swItems: [],           // flattened switcher result items
    swSelected: 0,
    swSearchTimer: null,
    swSearchSeq: 0
  };

  /* ---------------- dom ---------------- */
  var $ = function (sel) { return document.querySelector(sel); };
  var el = {
    sidebar: $('#sidebar'),
    sidebarScrim: $('#sidebar-scrim'),
    sidebarToggle: $('#sidebar-toggle'),
    sidebarClose: $('#sidebar-close'),
    brand: $('#brand-home'),
    treeFilter: $('#tree-filter'),
    tree: $('#topic-tree'),
    tabbar: $('#tabbar'),
    content: $('#content'),
    status: $('#status-text'),
    graphPane: $('#graphpane'),
    graphToggle: $('#graph-toggle'),
    graphClose: $('#graph-close'),
    graphCanvas: $('#graph-canvas'),
    localToggle: $('#local-graph-toggle'),
    hopsToggle: $('#graph-hops-toggle'),
    switcher: $('#switcher'),
    switcherInput: $('#switcher-input'),
    switcherResults: $('#switcher-results'),
    switcherHint: $('#open-switcher-hint'),
    authGate: $('#auth-gate')
  };

  /* ---------------- utils ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function str(x) { return typeof x === 'string' ? x : (x == null ? '' : String(x)); }
  function num(x) { var n = Number(x); return isFinite(n) ? n : 0; }

  function humanize(s) {
    s = str(s).replace(/[_-]+/g, ' ').trim();
    if (!s) return '';
    return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // Normalize severity to none|low|mid|critical.
  // The compiled data stores severity as a numeric string "1"–"5" (5 = most
  // severe); older/string values ("critical", "moderate", …) are also handled.
  function sevKey(sev, gapCount) {
    var s = str(sev).toLowerCase();
    if (s === 'critical' || s === 'high' || s === 'severe') return 'critical';
    if (s === 'mid' || s === 'medium' || s === 'moderate') return 'mid';
    if (s === 'low' || s === 'minor') return 'low';
    // Numeric 1–5 scale: 5 → critical, 3–4 → mid, 1–2 → low.
    var n = num(sev);
    if (n >= 5) return 'critical';
    if (n >= 3) return 'mid';
    if (n >= 1) return 'low';
    if (num(gapCount) > 0) return 'low';
    return 'none';
  }
  // SFR Design System 2026: status colours (success green, warning orange, critical magenta)
  var SEV_COLOR = { none: '#a1abbe', low: '#20bf55', mid: '#ff8a00', critical: '#9200ff' };

  // Graph nodes are coloured by research domain (parent_topic). Only ~78 of 242
  // topics have a parent in the taxonomy; the rest are uncategorised and render
  // in a neutral grey. Keys are the raw parent_topic slugs from the DB.
  var DOMAIN_COLOR = {
    agri_economics:        '#0f3057',
    animal_health:         '#204e82',
    crop_production:       '#20bf55',
    environment:           '#00b8cc',
    food_processing:       '#3f89bb',
    food_safety:           '#081f44',
    food_systems:          '#79a9cf',
    genetics:              '#5c6b8a',
    livestock:             '#a1abbe',
    nutrition:             '#14965f',
    plant_health:          '#7fd99b',
    precision_agriculture: '#66f1ff',
    social_rural:          '#b9c7dc',
    soil:                  '#47566e',
    water:                 '#2f6aa8'
  };
  var DOMAIN_FALLBACK = '#d1d6e3';   // uncategorised topics (no parent_topic)

  function domainColor(parent) {
    return DOMAIN_COLOR[str(parent)] || DOMAIN_FALLBACK;
  }

  function wordCount(md) {
    var t = str(md).trim();
    return t ? t.split(/\s+/).length : 0;
  }

  function trendChip(trend) {
    var t = str(trend).toLowerCase();
    if (!t) return '';
    var cls = '', icon = '→';
    if (/(up|rising|increas|grow)/.test(t)) { cls = 'up'; icon = '↗'; }
    else if (/(down|declin|decreas|falling|shrink)/.test(t)) { cls = 'down'; icon = '↘'; }
    return '<span class="meta-chip trend-chip ' + cls + '">' + icon + ' Funding ' + esc(humanize(t)) + '</span>';
  }

  function sourceBadge(source) {
    var s = str(source).toLowerCase() || 'other';
    var known = (s === 'aramis' || s === 'snf' || s === 'regiosuisse') ? s : 'other';
    return '<span class="source-badge ' + known + '">' + esc(s || 'source') + '</span>';
  }

  /* ---------------- reference linkification ---------------- */
  // Project references (#aramis:408, #snf:218400, #regiosuisse:4694) and
  // [[topic]] wiki-links are converted to real links here, deterministically,
  // so links work regardless of how the LLM formatted them (bare id, markdown
  // link, or a malformed "[#id] (url)"). This runs on every article field.
  var PROJECT_BASE = {
    aramis: 'https://www.aramis.admin.ch/Grunddaten/?ProjectID=',
    snf: 'https://data.snf.ch/grants/grant/',
    regiosuisse: 'https://regiosuisse.ch/projekte/projektdatenbank?project-id='
  };
  function projectUrl(src, id) {
    var b = PROJECT_BASE[str(src).toLowerCase()];
    return b ? b + id : null;
  }
  function slugifyName(name) {
    return str(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  function resolveTopicSlug(name) {
    var raw = str(name).trim();
    if (state.topicMap[raw]) return raw;              // already a valid slug
    var sl = slugifyName(raw);
    if (state.topicMap[sl]) return sl;
    var hit = (state.topics || []).filter(function (t) {
      return str(t.label || t.topic_label).toLowerCase() === raw.toLowerCase();
    })[0];
    return hit ? (hit.slug || hit.topic_slug) : sl;
  }
  function isKnownTopic(name) {
    var s = resolveTopicSlug(name);
    return !!state.topicMap[s];
  }
  function topicLinkHtml(name) {
    var slug = resolveTopicSlug(name);
    var t = state.topicMap[slug];
    var label = t ? str(t.label || t.topic_label || humanize(slug)) : humanize(str(name).replace(/_/g, ' '));
    return '<button class="topic-ref" type="button" data-open-topic="' + esc(slug) + '">' + esc(label) + '</button>';
  }
  // #src:id  — also swallows a surrounding markdown-link wrapper "[#src:id](url)"
  // or the malformed "[#src:id] (url)" the model sometimes emits.
  var RE_PROJ = /\[?#(aramis|snf|regiosuisse):(\d+)\]?(?:\s*\([^)\s]*\))?/gi;
  var RE_WIKI = /\[\[\s*([^\[\]]+?)\s*\]\]/g;
  // Linkify an ALREADY-ESCAPED string -> safe HTML (our hrefs are controlled).
  function linkifyEscaped(s) {
    s = str(s).replace(RE_PROJ, function (m, src, id) {
      var url = projectUrl(src, id), label = '#' + src.toLowerCase() + ':' + id;
      return url ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer" class="proj-ref">' + label + '</a>' : label;
    });
    s = s.replace(RE_WIKI, function (m, name) { return topicLinkHtml(name); });
    return s;
  }
  // For plain-text fields (key findings, gap descriptions): escape then linkify.
  function linkifyPlain(t) { return linkifyEscaped(esc(t)); }

  /* ---------------- markdown (sanitized + linkified) ---------------- */
  function renderMarkdown(md) {
    var html = '';
    try {
      html = (window.marked && marked.parse) ? marked.parse(str(md)) : esc(md);
    } catch (e) { html = '<p>' + esc(md) + '</p>'; }
    return sanitizeHtml(html);
  }

  function sanitizeHtml(html) {
    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); }
    catch (e) { return esc(html); }
    var bad = doc.querySelectorAll('script, style, iframe, object, embed, form, link, meta, base');
    bad.forEach(function (n) { n.remove(); });
    var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    var node;
    while ((node = walker.nextNode())) {
      // strip event handlers + dangerous urls
      for (var i = node.attributes.length - 1; i >= 0; i--) {
        var a = node.attributes[i];
        var name = a.name.toLowerCase();
        var val = str(a.value).replace(/\s+/g, '').toLowerCase();
        if (name.indexOf('on') === 0) { node.removeAttribute(a.name); continue; }
        if ((name === 'href' || name === 'src' || name === 'xlink:href') &&
            (val.indexOf('javascript:') === 0 || val.indexOf('data:text/html') === 0 || val.indexOf('vbscript:') === 0)) {
          node.removeAttribute(a.name);
        }
      }
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
    // Bold topic slugs (e.g. **food_processing** in "Connections") -> topic links.
    doc.body.querySelectorAll('strong, b').forEach(function (b) {
      if (b.children.length === 0 && isKnownTopic(b.textContent)) {
        var holder = doc.createElement('span');
        holder.innerHTML = topicLinkHtml(b.textContent);
        b.replaceWith(holder.firstChild);
      }
    });
    // Linkify bare #src:id and [[topic]] in text nodes, skipping existing links/code.
    var tw = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);
    var texts = [], tn;
    while ((tn = tw.nextNode())) texts.push(tn);
    texts.forEach(function (t) {
      if (t.parentNode && t.parentNode.closest && t.parentNode.closest('a, button, code, pre')) return;
      var v = t.nodeValue;
      if (v.search(/#(aramis|snf|regiosuisse):\d+/i) < 0 && v.indexOf('[[') < 0) return;
      var holder = doc.createElement('span');
      holder.innerHTML = linkifyEscaped(esc(v));
      t.replaceWith(holder);
    });
    return doc.body.innerHTML;
  }

  /* ---------------- api ---------------- */
  function authHeaders(extra) {
    var h = { Authorization: 'Bearer ' + (session ? session.access_token : '') };
    for (var k in (extra || {})) h[k] = extra[k];
    return h;
  }
  function api(path) {
    if (!session) { showGate('signin'); return Promise.reject(new Error('unauthorized')); }
    return fetch(FN + '?path=' + encodeURIComponent(path), { headers: authHeaders() }).then(handleApiRes);
  }
  function apiPost(path, body) {
    if (!session) { showGate('signin'); return Promise.reject(new Error('unauthorized')); }
    return fetch(FN + '?path=' + encodeURIComponent(path), {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body || {})
    }).then(handleApiRes);
  }
  function showGate(kind) {
    var g = el.authGate;
    var t = g.querySelector('h2'), p = g.querySelector('p'), a = g.querySelector('.auth-link');
    if (kind === 'member') {
      t.textContent = 'For members of Swiss Food Research';
      p.textContent = 'You are signed in as ' + (session && session.user ? session.user.email : '') +
        ', which is not a member address. Radicle \u2013 Knowledge is open to everyone at a member organisation: sign in with your work address there.';
      a.textContent = 'Sign in with another address';
    } else {
      t.textContent = 'Sign in to open Radicle \u2013 Knowledge';
      p.textContent = 'Topic articles on Swiss agro-food research, about 6,600 funded projects from ARAMIS, SNF and Regiosuisse, and a funding finder for your project idea. Open to everyone at a member organisation of Swiss Food Research.';
      a.textContent = 'Sign in';
    }
    g.hidden = false;
  }
  function handleApiRes(res) {
    if (res.status === 401) {
      showGate('signin');
      throw new Error('unauthorized');
    }
    if (res.status === 403) {
      showGate('member');
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // The Funding Finder is a non-topic view that lives in its own tab, keyed by
  // this reserved slug (no real topic can collide — slugs are lowercase words).
  var FINDER_SLUG = '__finder__';
  function hashFor(slug) {
    return slug === FINDER_SLUG ? '#/funding-finder' : '#/topic/' + encodeURIComponent(slug);
  }

  /* ============================================================
     SIDEBAR TREE
     ============================================================ */
  var openFolders = {};  // key -> bool

  function buildTree(filter) {
    filter = str(filter).toLowerCase().trim();
    var topics = state.topics.filter(function (t) {
      if (!filter) return true;
      return str(t.label).toLowerCase().indexOf(filter) !== -1 ||
             str(t.slug).toLowerCase().indexOf(filter) !== -1;
    });

    if (!topics.length) {
      el.tree.innerHTML = '<div class="tree-empty">No topics match “' + esc(filter) + '”.</div>';
      return;
    }

    // group by parent_topic
    var groups = {}, orphans = [];
    topics.forEach(function (t) {
      var p = str(t.parent_topic).trim();
      if (p) { (groups[p] = groups[p] || []).push(t); }
      else orphans.push(t);
    });
    var groupKeys = Object.keys(groups).sort();

    var html = '';
    groupKeys.forEach(function (k) {
      var items = groups[k].sort(byLabel);
      html += folderHtml('g:' + k, humanize(k), items, !!filter);
    });

    // orphans: alphabetical letter-groups inside an "All topics" folder
    if (orphans.length) {
      orphans.sort(byLabel);
      var open = filter ? true : (openFolders['g:__all__'] !== false && openFolders['g:__all__'] === true);
      html += '<div class="tree-folder' + (filter || openFolders['g:__all__'] ? ' open' : '') + '" data-key="g:__all__">' +
        '<button class="tree-folder-head" type="button"><span class="tree-chevron">▶</span>' +
        '<span>All Topics</span><span class="tree-count">' + orphans.length + '</span></button>' +
        '<div class="tree-children">';
      var letter = '';
      orphans.forEach(function (t) {
        var L = (str(t.label).charAt(0) || '#').toUpperCase();
        if (!/[A-Z]/.test(L)) L = '#';
        if (L !== letter) { letter = L; html += '<div class="tree-letter">' + L + '</div>'; }
        html += itemHtml(t);
      });
      html += '</div></div>';
      void open;
    }

    el.tree.innerHTML = html;
    markActiveInTree();
  }

  function byLabel(a, b) { return str(a.label).localeCompare(str(b.label)); }

  function folderHtml(key, label, items, forceOpen) {
    var open = forceOpen || !!openFolders[key];
    var h = '<div class="tree-folder' + (open ? ' open' : '') + '" data-key="' + esc(key) + '">' +
      '<button class="tree-folder-head" type="button"><span class="tree-chevron">▶</span>' +
      '<span>' + esc(label) + '</span><span class="tree-count">' + items.length + '</span></button>' +
      '<div class="tree-children">';
    items.forEach(function (t) { h += itemHtml(t); });
    return h + '</div></div>';
  }

  function itemHtml(t) {
    var sev = sevKey(t.max_severity, t.gap_count);
    var pc = num(t.project_count);
    return '<button class="tree-item" type="button" data-slug="' + esc(t.slug) + '" title="' + esc(t.label) + '">' +
      '<span class="sev-dot ' + sev + '"></span>' +
      '<span class="tree-item-label">' + esc(t.label) + '</span>' +
      (pc ? '<span class="tree-item-count">' + pc + '</span>' : '') +
      '</button>';
  }

  function markActiveInTree() {
    el.tree.querySelectorAll('.tree-item').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-slug') === state.activeSlug);
    });
    var navFinder = $('#nav-funding-finder');
    if (navFinder) navFinder.classList.toggle('active', state.activeSlug === FINDER_SLUG);
    // ensure folder containing active item is visible
    if (state.activeSlug) {
      var active = el.tree.querySelector('.tree-item.active');
      if (active) {
        var folder = active.closest('.tree-folder');
        if (folder && !folder.classList.contains('open')) {
          folder.classList.add('open');
          openFolders[folder.getAttribute('data-key')] = true;
        }
      }
    }
  }

  el.tree.addEventListener('click', function (e) {
    var head = e.target.closest('.tree-folder-head');
    if (head) {
      var folder = head.parentElement;
      var key = folder.getAttribute('data-key');
      folder.classList.toggle('open');
      openFolders[key] = folder.classList.contains('open');
      return;
    }
    var item = e.target.closest('.tree-item');
    if (item) {
      openTopic(item.getAttribute('data-slug'));
      closeSidebarOverlay();
    }
  });

  el.treeFilter.addEventListener('input', function () { buildTree(el.treeFilter.value); });

  /* ============================================================
     TABS + ROUTING
     ============================================================ */
  function saveTabs() {
    try {
      sessionStorage.setItem('radicle.tabs', JSON.stringify(state.tabs));
      sessionStorage.setItem('radicle.active', state.activeSlug || '');
    } catch (e) { /* private mode etc. */ }
  }
  function restoreTabs() {
    try {
      var t = JSON.parse(sessionStorage.getItem('radicle.tabs') || '[]');
      if (Array.isArray(t)) state.tabs = t.filter(function (x) { return x && x.slug; });
    } catch (e) { state.tabs = []; }
  }

  function labelFor(slug) {
    if (slug === FINDER_SLUG) return 'Funding Finder';
    var t = state.topicMap[slug];
    return t ? str(t.label) : humanize(slug);
  }

  function count(kind, ref) { if (window.SFR && window.SFR.track) window.SFR.track(kind, ref); }

  function openTopic(slug, opts) {
    if (!slug) return;
    opts = opts || {};
    if (slug !== state.activeSlug) count('kn_topic', slug);
    var existing = state.tabs.find(function (t) { return t.slug === slug; });
    if (!existing) state.tabs.push({ slug: slug, label: labelFor(slug) });
    state.activeSlug = slug;
    setHash(hashFor(slug));
    render();
  }

  function openFinder() {
    if (!state.tabs.find(function (t) { return t.slug === FINDER_SLUG; })) {
      state.tabs.push({ slug: FINDER_SLUG, label: labelFor(FINDER_SLUG) });
    }
    state.activeSlug = FINDER_SLUG;
    setHash(hashFor(FINDER_SLUG));
    render();
  }

  function closeTab(slug) {
    var idx = state.tabs.findIndex(function (t) { return t.slug === slug; });
    if (idx === -1) return;
    state.tabs.splice(idx, 1);
    if (state.activeSlug === slug) {
      var next = state.tabs[idx] || state.tabs[idx - 1];
      state.activeSlug = next ? next.slug : null;
      setHash(next ? hashFor(next.slug) : '#/');
    }
    render();
  }

  function goHome() {
    state.activeSlug = null;
    setHash('#/');
    render();
  }

  var suppressHash = false;
  function setHash(h) {
    if (location.hash === h) return;
    suppressHash = true;
    location.hash = h;
    setTimeout(function () { suppressHash = false; }, 0);
  }

  function handleHash() {
    if (suppressHash) return;
    if (/^#\/funding-finder$/.test(location.hash)) {
      if (state.activeSlug !== FINDER_SLUG) openFinder();
      return;
    }
    var m = location.hash.match(/^#\/topic\/(.+)$/);
    if (m) {
      var slug = decodeURIComponent(m[1]);
      if (slug !== state.activeSlug) openTopic(slug);
    } else {
      state.activeSlug = null;
      render();
    }
  }
  window.addEventListener('hashchange', handleHash);

  function renderTabs() {
    var h = '';
    state.tabs.forEach(function (t) {
      h += '<div class="tab' + (t.slug === state.activeSlug ? ' active' : '') + '" data-slug="' + esc(t.slug) + '" role="tab" aria-selected="' + (t.slug === state.activeSlug) + '" title="' + esc(t.label) + '">' +
        '<span class="tab-label">' + esc(t.label) + '</span>' +
        '<button class="tab-close" type="button" title="Close" aria-label="Close tab">×</button>' +
        '</div>';
    });
    el.tabbar.innerHTML = h;
    var active = el.tabbar.querySelector('.tab.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  el.tabbar.addEventListener('click', function (e) {
    var tab = e.target.closest('.tab');
    if (!tab) return;
    var slug = tab.getAttribute('data-slug');
    if (e.target.closest('.tab-close')) { closeTab(slug); return; }
    if (slug !== state.activeSlug) {
      state.activeSlug = slug;
      setHash(hashFor(slug));
      render();
    }
  });
  // middle-click closes a tab, like Obsidian
  el.tabbar.addEventListener('auxclick', function (e) {
    if (e.button !== 1) return;
    var tab = e.target.closest('.tab');
    if (tab) { e.preventDefault(); closeTab(tab.getAttribute('data-slug')); }
  });

  /* ============================================================
     RENDER (dispatch)
     ============================================================ */
  function render() {
    renderTabs();
    markActiveInTree();
    saveTabs();
    if (state.activeSlug === FINDER_SLUG) renderFinder();
    else if (state.activeSlug) renderArticle(state.activeSlug);
    else renderHome();
    updateGraphHighlight();
  }

  /* ---------------- home view ---------------- */
  function renderHome() {
    el.status.textContent = '';
    var topics = state.topics;
    // Authoritative counts come from /stats — summing per-topic counters
    // over-counts projects (multi-topic membership) and drops gaps whose
    // topic has no article. Fetch once; re-render home when it arrives.
    if (!state.stats && !state.statsLoading) {
      state.statsLoading = true;
      api('/stats').then(function (s) {
        state.stats = s || null;
        if (!state.activeSlug) renderHome();
      }).catch(function () { state.statsLoading = false; });
    }
    var stats = state.stats;
    var fmt = function (n) { return num(n).toLocaleString('de-CH'); };
    var starters = topics.slice().sort(function (a, b) { return num(b.project_count) - num(a.project_count); }).slice(0, 6);

    var h = '<div class="content-inner">' +
      '<div class="home-hero">' +
        '<span class="home-logo"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18"/><path d="M12 9c0-3-2.5-5-5.5-5C6.5 7 9 9 12 9z"/><path d="M12 14c0-3 2.5-5 5.5-5C17.5 12 15 14 12 14z"/></svg></span>' +
        '<h1 class="home-title">Radicle \u2013 Knowledge</h1>' +
        '<p class="home-sub">A living map of Swiss agro-food research: what is being funded, what has been learned, and where the funding gaps are. Pick a topic from the sidebar or jump right in below.</p>' +
      '</div>' +
      '<div class="home-stats">' +
        '<div class="stat-card"><div class="stat-num">' + topics.length + '</div><div class="stat-label">Topics</div></div>' +
        '<div class="stat-card"><div class="stat-num">' + (stats ? fmt(stats.projects) : '…') + '</div><div class="stat-label">Projects analysed</div></div>' +
        '<div class="stat-card"><div class="stat-num">' + (stats ? fmt(stats.gaps) : '…') + '</div><div class="stat-label">Funding gaps</div></div>' +
        '<div class="stat-card"><div class="stat-num">' + (stats ? fmt(stats.critical_gaps) : '…') + '</div><div class="stat-label">Critical gaps</div></div>' +
      '</div>' +
      '<p class="home-hint">Tip: press <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> to search topics and projects from anywhere.</p>';

    if (starters.length) {
      h += '<div class="section"><div class="section-title">Start here</div><div class="start-grid">';
      starters.forEach(function (t) {
        var sev = sevKey(t.max_severity, t.gap_count);
        h += '<button class="start-card" type="button" data-slug="' + esc(t.slug) + '">' +
          '<div class="sc-label"><span class="sev-dot ' + sev + '"></span>' + esc(t.label) + '</div>' +
          '<div class="sc-meta">' + num(t.project_count) + ' projects · ' + num(t.gap_count) + (t.gap_count === 1 ? ' gap' : ' gaps') + '</div>' +
          '</button>';
      });
      h += '</div></div>';
    }
    h += '</div>';
    el.content.innerHTML = h;
  }

  el.content.addEventListener('click', function (e) {
    var sc = e.target.closest('[data-open-topic], .start-card');
    if (sc) {
      var slug = sc.getAttribute('data-slug') || sc.getAttribute('data-open-topic');
      if (slug) openTopic(slug);
    }
  });

  /* ---------------- funding finder view ---------------- */
  var SEV_LABEL = { 5: 'Critical', 4: 'Major', 3: 'Significant', 2: 'Minor', 1: 'Negligible' };

  function renderFinder() {
    el.status.textContent = '';
    var f = state.finder;
    var h = '<div class="content-inner finder">' +
      '<h1 class="finder-h1">Funding Finder</h1>' +
      '<p class="finder-lead">Describe your project idea to find matching research gaps, funding instruments, and the right SFR contact.</p>' +
      '<div class="finder-form">' +
        '<textarea id="finder-idea" class="finder-idea" rows="4" placeholder="e.g. We are developing a precision fermentation platform to produce animal-free whey proteins at scale for the Swiss food industry…">' + esc(f.idea) + '</textarea>' +
        '<div class="finder-controls">' +
          '<label class="finder-check"><input type="checkbox" id="finder-active"' + (f.activeOnly ? ' checked' : '') + '> Active in ' + checkYear() + ' only</label>' +
          '<label class="finder-sev">Min. gap severity ' +
            '<select id="finder-sev">' +
              [1, 2, 3, 4, 5].map(function (n) { return '<option value="' + n + '"' + (n === f.minSev ? ' selected' : '') + '>Level ' + n + '+</option>'; }).join('') +
            '</select>' +
          '</label>' +
          '<button id="finder-go" class="finder-go" type="button"' + (f.loading ? ' disabled' : '') + '>' + (f.loading ? 'Matching…' : 'Find matches') + '</button>' +
        '</div>' +
      '</div>' +
      '<div id="finder-results" class="finder-results">' + finderResultsHtml() + '</div>' +
    '</div>';
    el.content.innerHTML = h;
    wireFinder();
  }

  function finderResultsHtml() {
    var f = state.finder;
    if (f.loading) return '<div class="state-block"><div class="spinner"></div>Matching your idea…</div>';
    if (!f.result) return finderBrowseHtml();

    var r = f.result, h = '';

    // Contacts
    if (r.contacts && r.contacts.length) {
      h += '<div class="finder-section"><div class="finder-section-t">Your SFR contact</div><div class="contact-row">';
      r.contacts.forEach(function (c) {
        var initials = str(c.name).split(' ').slice(0, 2).map(function (p) { return p.charAt(0); }).join('').toUpperCase();
        h += '<div class="contact-card">' +
          '<div class="contact-av">' + esc(initials) + '</div>' +
          '<div class="contact-meta"><div class="contact-name">' + esc(c.name) + '</div>' +
          '<div class="contact-role">' + esc(c.role || '') + '</div>' +
          '<a class="contact-mail" href="' + COACHING + '" target="_blank" rel="noopener">Book a meeting</a>' +
          '</div></div>';
      });
      h += '</div></div>';
    }

    h += '<div class="finder-cols">';

    // Gaps
    h += '<div class="finder-section"><div class="finder-section-t">Research gaps you could address (' + r.gaps.length + ')</div>';
    if (!r.gaps.length) h += '<div class="finder-empty">No closely matching gaps. Try different wording.</div>';
    r.gaps.forEach(function (g) {
      var sev = sevKey(g.severity, 1);
      h += '<div class="gap-card sev-' + sev + '">' +
        '<div class="gap-card-top"><span class="sev-badge ' + sev + '">' + esc(str(g.severity)) + '</span>' +
        '<a class="finder-gap-topic" href="' + hashFor(g.topic_slug) + '">' + esc(g.topic_label) + '</a>' +
        (g.cost_range_chf ? '<span class="gap-cost">' + (/chf/i.test(str(g.cost_range_chf)) ? '' : 'CHF ') + esc(g.cost_range_chf) + '</span>' : '') +
        '</div>' +
        '<div class="gap-desc">' + linkifyPlain(g.description) + '</div>' +
        (g.evidence_block ? '<div class="gap-reason"><strong>Grant justification:</strong> ' + linkifyPlain(g.evidence_block) + '</div>' : '') +
        '</div>';
    });
    h += '</div>';

    // Instruments — split into tailored (topic match) vs general (fallback),
    // so a weak/absent match is never presented as tailored to the idea.
    var tailored = r.instruments.filter(function (i) { return i.tailored; });
    var general = r.instruments.filter(function (i) { return i.tailored === false; });
    h += '<div class="finder-section"><div class="finder-section-t">Funding instruments</div>';
    if (tailored.length) {
      h += '<div class="finder-subhead">Matched to your idea (' + tailored.length + ')</div>';
      tailored.forEach(function (i) { h += instrumentCardHtml(i); });
    } else {
      h += '<div class="finder-empty">No instrument closely matches your wording. The schemes below are open to most Swiss food & agri projects. Try rephrasing with the key topic or technology.</div>';
    }
    if (general.length) {
      h += '<div class="finder-subhead finder-subhead-muted">General Swiss &amp; EU funding' +
        '<span class="finder-hint" title="Broadly applicable programmes shown as a starting point, not matched to your specific idea.">ⓘ</span></div>';
      general.forEach(function (i) { h += instrumentCardHtml(i); });
    }
    if (!r.instruments.length) h += '<div class="finder-empty">No applicable instruments found.</div>';
    h += '</div>';

    h += '</div>';
    return h;
  }

  function finderBrowseHtml() {
    var f = state.finder;
    if (!f.instruments) return '<div class="state-block"><div class="spinner"></div>Loading instruments…</div>';
    var list = f.instruments.filter(function (i) { return i.active; });
    var h = '<div class="finder-section"><div class="finder-section-t">Funding instruments (' + list.length + ' active)</div>' +
      '<div class="finder-browse">';
    list.forEach(function (i) { h += instrumentCardHtml(i); });
    h += '</div></div>';
    return h;
  }

  // The year the Funding Schemes board checked the programmes for (from the data; the current year if missing).
  function checkYear() {
    var all = (state.finder.instruments || []).concat((state.finder.result && state.finder.result.instruments) || []);
    for (var k = 0; k < all.length; k++) if (all[k].check_year) return all[k].check_year;
    return new Date().getFullYear();
  }
  function fmtDate(d) {
    if (!d) return '';
    var p = String(d).split('-');
    var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(p[1]) - 1];
    return Number(p[2]) + ' ' + m + ' ' + p[0];
  }
  function instrumentCardHtml(i) {
    var year = i.check_year || checkYear();
    var badge = i.active && i.status === 'yes' ? '<span class="inst-badge active">Active ' + year + '</span>'
      : i.active ? '<span class="inst-badge likely">Likely active ' + year + '</span>'
      : i.status === 'no' || i.deadline_type === 'closed' ? '<span class="inst-badge closed">Not open in ' + year + '</span>'
      : '<span class="inst-badge">Check status</span>';
    var when = i.deadline ? 'Deadline ' + fmtDate(i.deadline)
      : i.deadline_type && i.deadline_type !== 'closed' ? i.deadline_type.charAt(0).toUpperCase() + i.deadline_type.slice(1) : '';
    if (i.opens_on && i.deadline_type === 'upcoming / announced') when = 'Opens ' + fmtDate(i.opens_on) + (when ? ' · ' + when : '');
    var link = i.link ? '<a class="inst-link" href="' + esc(i.link) + '" target="_blank" rel="noopener noreferrer">Open →</a>' : '';
    var topic = i.project_topic ? '<div class="inst-topic">' + esc(str(i.project_topic).slice(0, 150)) + (str(i.project_topic).length > 150 ? '…' : '') + '</div>' : '';
    return '<div class="inst-card">' +
      '<div class="inst-top"><span class="inst-name">' + esc(i.name) + '</span>' + badge + '</div>' +
      '<div class="inst-meta">' + esc(i.funder || '\u2013') +
        (i.funding_type ? ' · ' + esc(i.funding_type) : '') +
        (i.stage ? ' · ' + esc(i.stage) : '') +
        (i.max_funding_chf ? ' · <span class="inst-max">max. ' + esc(i.max_funding_chf) + '</span>' : '') +
      '</div>' +
      (when ? '<div class="inst-when">' + esc(when) + '</div>' : '') +
      topic +
      '<div class="inst-foot">' + link + (i.verified_on ? '<span class="inst-verified">Verified ' + fmtDate(i.verified_on) + '</span>' : '') + '</div>' +
    '</div>';
  }

  function wireFinder() {
    var idea = $('#finder-idea'), go = $('#finder-go'),
        active = $('#finder-active'), sev = $('#finder-sev');
    if (!go) return;

    // Load the browse list once, if we have no search result yet.
    if (!state.finder.result && !state.finder.instruments) {
      api('/instruments').then(function (list) {
        state.finder.instruments = arr(list);
        if (state.activeSlug === FINDER_SLUG && !state.finder.result) {
          var box = $('#finder-results'); if (box) box.innerHTML = finderBrowseHtml();
        }
      }).catch(function () {});
    }

    function run() {
      var text = str(idea.value).trim();
      if (text.length < 10) { idea.focus(); idea.classList.add('shake'); setTimeout(function () { idea.classList.remove('shake'); }, 500); return; }
      state.finder.idea = text;
      state.finder.activeOnly = active.checked;
      state.finder.minSev = num(sev.value) || 2;
      state.finder.loading = true;
      $('#finder-results').innerHTML = finderResultsHtml();
      go.disabled = true; go.textContent = 'Matching…';
      function resetBtn() { if (go) { go.disabled = false; go.textContent = 'Find matches'; } }
      count('kn_finder');   // the idea itself is never sent anywhere but the finder
      apiPost('/funding-finder', { idea: text, active_only: state.finder.activeOnly, min_severity: state.finder.minSev })
        .then(function (res) {
          state.finder.result = res; state.finder.loading = false;
          resetBtn();
          if (state.activeSlug === FINDER_SLUG) $('#finder-results').innerHTML = finderResultsHtml();
        })
        .catch(function (err) {
          state.finder.loading = false;
          resetBtn();
          if (err.message === 'unauthorized') return;
          if (state.activeSlug === FINDER_SLUG) $('#finder-results').innerHTML = '<div class="finder-empty">Search failed (' + esc(err.message) + '). Please try again.</div>';
        });
    }

    go.addEventListener('click', run);
    idea.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run();
    });
    // Clicking a matched-gap topic link opens it as a wiki tab (hash routing).
    $('#finder-results').addEventListener('click', function (e) {
      var a = e.target.closest('.finder-gap-topic'); if (!a) return;
      e.preventDefault();
      var m = a.getAttribute('href').match(/#\/topic\/(.+)$/);
      if (m) openTopic(decodeURIComponent(m[1]));
    });
  }

  /* ---------------- article view ---------------- */
  var renderSeq = 0;
  function renderArticle(slug) {
    var seq = ++renderSeq;
    var cached = state.articleCache[slug];
    if (cached) { paintArticle(cached); return; }

    el.content.innerHTML = '<div class="state-block"><div class="spinner"></div>Loading ' + esc(labelFor(slug)) + '…</div>';
    el.status.textContent = '';

    api('/topics/' + encodeURIComponent(slug)).then(function (a) {
      a = a || {};
      a.slug = a.slug || slug;
      state.articleCache[slug] = a;
      // improve tab label with real title
      var tab = state.tabs.find(function (t) { return t.slug === slug; });
      if (tab && (a.label || a.title)) { tab.label = str(a.label || a.title); renderTabs(); saveTabs(); }
      if (seq === renderSeq && state.activeSlug === slug) paintArticle(a);
    }).catch(function (err) {
      if (err.message === 'unauthorized') return;
      if (seq !== renderSeq || state.activeSlug !== slug) return;
      el.content.innerHTML = '<div class="state-block">Could not load “' + esc(labelFor(slug)) + '” (' + esc(err.message) + ').<br><br>' +
        '<button class="wikilink" type="button" data-retry="' + esc(slug) + '">Retry</button></div>';
    });
  }

  el.content.addEventListener('click', function (e) {
    var r = e.target.closest('[data-retry]');
    if (r) { delete state.articleCache[r.getAttribute('data-retry')]; renderArticle(r.getAttribute('data-retry')); }
  });

  function paintArticle(a) {
    var title = str(a.title || a.label || humanize(a.slug));
    var findings = arr(a.key_findings);
    var spots = arr(a.white_spots);
    var related = arr(a.related_topics).filter(function (x) { return x && x.slug; });
    var backlinks = arr(a.backlinks).filter(function (x) { return x && x.slug; });
    var activeP = arr(a.active_projects);
    var doneP = arr(a.completed_projects);
    var words = wordCount(a.body_markdown);

    var h = '<div class="content-inner"><article>';
    h += '<h1 class="article-title">' + esc(title) + '</h1>';

    // meta row
    h += '<div class="article-meta">';
    if (a.parent_topic) h += '<span class="meta-chip">' + esc(humanize(a.parent_topic)) + '</span>';
    h += trendChip(a.funding_trend);
    h += '<span>' + (activeP.length + doneP.length) + ' projects</span>';
    if (a.last_compiled) h += '<span>· compiled ' + esc(str(a.last_compiled).slice(0, 10)) + '</span>';
    h += '</div>';

    // body markdown
    h += '<div class="article-body">' + (str(a.body_markdown).trim() ? renderMarkdown(a.body_markdown) : '<p class="empty-note">No article body compiled yet.</p>') + '</div>';

    // key findings
    if (findings.length) {
      h += section('Key Findings', findings.length,
        '<ul class="findings-list">' + findings.map(function (f) { return '<li>' + linkifyPlain(f) + '</li>'; }).join('') + '</ul>');
    }

    // funding gaps
    if (spots.length) {
      var cards = spots.map(function (s) {
        s = s || {};
        var sev = sevKey(s.severity, 1);
        var c = '<div class="gap-card sev-' + sev + '">' +
          '<div class="gap-card-top"><span class="sev-badge ' + sev + '">' + esc(str(s.severity) || sev) + '</span>' +
          (s.cost_range_chf ? '<span class="gap-cost">' + (/chf/i.test(str(s.cost_range_chf)) ? '' : 'CHF ') + esc(s.cost_range_chf) + '</span>' : '') + '</div>' +
          '<div class="gap-desc">' + linkifyPlain(s.description || 'Unspecified gap') + '</div>' +
          (s.gap_reason ? '<div class="gap-reason"><strong>Why it is a gap:</strong> ' + linkifyPlain(s.gap_reason) + '</div>' : '') +
          '</div>';
        return c;
      }).join('');
      h += section('Funding Gaps', spots.length, cards);
    }

    // related topics
    if (related.length) {
      h += section('Related Topics', related.length,
        '<div class="pill-row">' + related.map(function (r) {
          return '<button class="wikilink" type="button" data-open-topic="' + esc(r.slug) + '">' + esc(r.label || humanize(r.slug)) + '</button>';
        }).join('') + '</div>');
    }

    // projects
    if (activeP.length || doneP.length) {
      var body = '';
      if (activeP.length) body += '<div class="proj-group-label">Active (' + activeP.length + ')</div>' + projList(activeP, 'active');
      if (doneP.length) body += '<div class="proj-group-label">Completed (' + doneP.length + ')</div>' + projList(doneP, 'completed');
      h += section('Projects', activeP.length + doneP.length, body);
    }

    // backlinks
    h += section('Linked mentions', backlinks.length,
      backlinks.length
        ? backlinks.map(function (b) {
            return '<button class="backlink-item" type="button" data-open-topic="' + esc(b.slug) + '">' +
              '<span class="bl-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg></span>' +
              esc(b.label || humanize(b.slug)) + '</button>';
          }).join('')
        : '<p class="empty-note">No other articles link to this one yet.</p>');

    h += '</article></div>';
    el.content.innerHTML = h;
    el.content.scrollTop = 0;
    el.status.textContent = backlinks.length + ' backlink' + (backlinks.length === 1 ? '' : 's') + ' · ' + words + ' word' + (words === 1 ? '' : 's');
  }

  function section(title, count, body) {
    return '<div class="section"><div class="section-title">' + esc(title) +
      (count ? '<span class="count-badge">' + count + '</span>' : '') + '</div>' + body + '</div>';
  }

  function projList(list, status) {
    return '<ul class="proj-list">' + list.map(function (p) {
      p = p || {};
      var title = esc(p.title || ('Project ' + str(p.id)));
      var inner = '<span class="proj-status-dot ' + status + '" title="' + status + '"></span>' +
        (p.url
          ? '<a class="proj-title" href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer" title="' + title + '">' + title + '</a>'
          : '<span class="proj-title" title="' + title + '">' + title + '</span>') +
        sourceBadge(p.source) +
        (p.url ? '<span class="ext-arrow">↗</span>' : '');
      return '<li class="proj-item">' + inner + '</li>';
    }).join('') + '</ul>';
  }

  /* ============================================================
     GRAPH PANE
     ============================================================ */
  function toggleGraph(force) {
    var show = typeof force === 'boolean' ? force : el.graphPane.hidden;
    el.graphPane.hidden = !show;
    el.graphToggle.classList.toggle('active', show);
    if (show) ensureGraph();
  }

  el.graphToggle.addEventListener('click', function () { toggleGraph(); });
  el.graphClose.addEventListener('click', function () { toggleGraph(false); });
  function syncHopsControl() {
    // The hops control only makes sense in local mode.
    if (el.hopsToggle) el.hopsToggle.parentElement.style.display = state.graphLocal ? '' : 'none';
  }
  el.localToggle.addEventListener('change', function () {
    state.graphLocal = el.localToggle.checked;
    syncHopsControl();
    applyGraphData();
  });
  if (el.hopsToggle) {
    el.hopsToggle.addEventListener('change', function () {
      state.graphHops = el.hopsToggle.checked ? 2 : 1;
      applyGraphData();
    });
  }
  syncHopsControl();

  function ensureGraph() {
    if (state.graph) { resizeGraph(); return; }
    if (typeof ForceGraph !== 'function') {
      el.graphCanvas.innerHTML = '<div class="state-block">Graph library failed to load.</div>';
      return;
    }
    var fetchP = state.graphData
      ? Promise.resolve(state.graphData)
      : api('/graph').then(function (g) {
          g = g || {};
          state.graphData = { nodes: arr(g.nodes), links: arr(g.links) };
          // Build the adjacency map once — drives local mode + hover focus.
          state.graphAdj = {};
          state.graphData.links.forEach(function (l) {
            var s = linkEnd(l.source), t = linkEnd(l.target);
            (state.graphAdj[s] = state.graphAdj[s] || {})[t] = true;
            (state.graphAdj[t] = state.graphAdj[t] || {})[s] = true;
          });
          return state.graphData;
        });

    fetchP.then(function () {
      if (state.graph) return;
      state.graph = ForceGraph()(el.graphCanvas)
        .backgroundColor('#ffffff')
        .nodeId('id')
        .nodeVal(function (n) { return Math.max(1, num(n.project_count)); })
        .nodeLabel(function (n) {
          return '<div style="font-family:Noto Sans,sans-serif;font-size:12px;padding:2px 4px;">' +
            '<b>' + esc(n.label || n.id) + '</b><br>' +
            num(n.project_count) + ' projects · ' + num(n.gap_count) + (n.gap_count === 1 ? ' gap' : ' gaps') + '</div>';
        })
        .nodeCanvasObjectMode(function () { return 'replace'; })
        .nodeCanvasObject(function (node, ctx, globalScale) {
          var r = 3 + Math.sqrt(Math.max(0, num(node.project_count))) * 1.4;
          var sev = sevKey(node.max_severity, node.gap_count);
          var hov = state.graphHover;
          var isHov = hov && node.id === hov.id;
          var isHovNb = hov && state.graphAdj[hov.id] && state.graphAdj[hov.id][node.id];
          // Focus dimming: while hovering, everything outside the hovered
          // node's neighbourhood fades back.
          var dimmed = hov && !isHov && !isHovNb && node.id !== state.activeSlug;
          ctx.globalAlpha = dimmed ? 0.12 : 1;
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          ctx.fillStyle = domainColor(node.parent_topic);
          ctx.fill();
          // Gap signal kept as a coloured ring so domain colour and severity
          // both read at once: red ring = critical gaps, amber = moderate.
          if (sev === 'critical' || sev === 'mid') {
            ctx.lineWidth = 2 / globalScale;
            ctx.strokeStyle = SEV_COLOR[sev];
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 1.6 / globalScale, 0, 2 * Math.PI);
            ctx.stroke();
          }
          if (node.id === state.activeSlug) {
            ctx.lineWidth = 2.5 / globalScale;
            ctx.strokeStyle = '#081f44';
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 4 / globalScale, 0, 2 * Math.PI);
            ctx.stroke();
          }
          // Labels: always in local mode (few nodes), plus hovered node,
          // its neighbours, the active node, and everything once zoomed in.
          var showLabel = !dimmed && (
            state.graphLocal || isHov || isHovNb ||
            globalScale > 1.4 || node.id === state.activeSlug
          );
          if (showLabel) {
            var label = str(node.label || node.id);
            var fs = Math.max(9 / globalScale, 2.4);
            var bold = node.id === state.activeSlug || isHov;
            ctx.font = (bold ? '700 ' : '') + fs + 'px "Noto Sans", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = bold ? '#081f44' : '#5c6b8a';
            ctx.fillText(label, node.x, node.y + r + 2 / globalScale);
          }
          ctx.globalAlpha = 1;
        })
        .nodePointerAreaPaint(function (node, color, ctx) {
          var r = 3 + Math.sqrt(Math.max(0, num(node.project_count))) * 1.4;
          ctx.beginPath();
          ctx.arc(node.x, node.y, r + 3, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        })
        .linkColor(function (l) {
          var hov = state.graphHover;
          if (!hov) return '#dae6f4';
          var s = linkEnd(l.source), t = linkEnd(l.target);
          // Links touching the hovered node light up; the rest fade back.
          return (s === hov.id || t === hov.id) ? '#3f89bb' : 'rgba(218,230,244,0.15)';
        })
        .linkWidth(function (l) {
          var hov = state.graphHover;
          if (!hov) return 1;
          var s = linkEnd(l.source), t = linkEnd(l.target);
          return (s === hov.id || t === hov.id) ? 1.8 : 1;
        })
        .onNodeHover(function (node) {
          state.graphHover = node || null;
          el.graphCanvas.style.cursor = node ? 'pointer' : '';
        })
        .onNodeClick(function (node) { if (node && node.id) openTopic(str(node.id)); })
        .onRenderFramePost(function (ctx, globalScale) { drawClusterLabels(ctx, globalScale); })
        .cooldownTicks(120);
      // Physics: default charge is too weak for a dense net in a narrow pane —
      // stronger repulsion + shorter links pull the clusters apart.
      state.graph.d3Force('charge').strength(-90);
      state.graph.d3Force('link').distance(40);
      applyGraphData();
      resizeGraph();
    }).catch(function (err) {
      if (err.message === 'unauthorized') return;
      el.graphCanvas.innerHTML = '<div class="state-block">Could not load graph (' + esc(err.message) + ').</div>';
    });
  }

  function linkEnd(v) { return (v && typeof v === 'object') ? v.id : v; }

  // Faint domain captions floating over each cluster's centroid. Full-graph
  // mode only (in local/hover views the per-node labels already name things,
  // and a single-cluster caption would just be noise).
  function drawClusterLabels(ctx, globalScale) {
    if (!state.graph || state.graphLocal || state.graphHover) return;
    var nodes = state.graph.graphData().nodes || [];
    var sums = {};   // parent -> {x, y, n}
    for (var i = 0; i < nodes.length; i++) {
      var p = str(nodes[i].parent_topic);
      if (!p || !DOMAIN_COLOR[p]) continue;   // skip uncategorised
      var acc = sums[p] || (sums[p] = { x: 0, y: 0, n: 0 });
      acc.x += nodes[i].x; acc.y += nodes[i].y; acc.n++;
    }
    var fs = Math.max(11 / globalScale, 3.5);
    ctx.font = '800 ' + fs + 'px "Noto Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var key in sums) {
      var c = sums[key];
      ctx.fillStyle = DOMAIN_COLOR[key];
      ctx.globalAlpha = 0.55;
      ctx.fillText(humanize(key), c.x / c.n, c.y / c.n);
    }
    ctx.globalAlpha = 1;
  }

  function applyGraphData() {
    if (!state.graph || !state.graphData) return;
    var nodes = state.graphData.nodes, links = state.graphData.links;
    if (state.graphLocal && state.activeSlug) {
      // Breadth-first expansion out to `graphHops` (1 or 2) from the active node.
      var keep = {};
      keep[state.activeSlug] = true;
      var frontier = [state.activeSlug];
      for (var hop = 0; hop < state.graphHops; hop++) {
        var next = [];
        frontier.forEach(function (id) {
          var nb = state.graphAdj[id];
          if (!nb) return;
          Object.keys(nb).forEach(function (other) {
            if (!keep[other]) { keep[other] = true; next.push(other); }
          });
        });
        frontier = next;
      }
      nodes = nodes.filter(function (n) { return keep[n.id]; });
      links = links.filter(function (l) { return keep[linkEnd(l.source)] && keep[linkEnd(l.target)]; });
    }
    // shallow-copy links so force-graph's node-object mutation doesn't corrupt the source data
    state.graph.graphData({
      nodes: nodes,
      links: links.map(function (l) { return { source: linkEnd(l.source), target: linkEnd(l.target) }; })
    });
    setTimeout(function () { if (state.graph) state.graph.zoomToFit(300, 24); }, 600);
  }

  function updateGraphHighlight() {
    if (!state.graph) return;
    if (state.graphLocal) applyGraphData();  // neighbourhood changed
  }

  function resizeGraph() {
    if (!state.graph) return;
    var rect = el.graphCanvas.getBoundingClientRect();
    state.graph.width(rect.width).height(rect.height);
  }
  if (window.ResizeObserver) {
    new ResizeObserver(function () { resizeGraph(); }).observe(el.graphCanvas);
  }
  window.addEventListener('resize', resizeGraph);

  /* ============================================================
     QUICK SWITCHER (⌘K)
     ============================================================ */
  function openSwitcher() {
    state.switcherOpen = true;
    state.swCounted = false;
    el.switcher.hidden = false;
    el.switcherInput.value = '';
    renderSwitcherResults('', null);
    el.switcherInput.focus();
  }
  function closeSwitcher() {
    state.switcherOpen = false;
    el.switcher.hidden = true;
    if (state.swSearchTimer) clearTimeout(state.swSearchTimer);
  }

  el.switcherHint.addEventListener('click', openSwitcher);
  el.switcher.addEventListener('click', function (e) { if (e.target === el.switcher) closeSwitcher(); });

  // simple subsequence fuzzy match; returns {score, marks} or null
  function fuzzy(query, target) {
    var q = query.toLowerCase(), t = target.toLowerCase();
    if (!q) return { score: 0, marks: [] };
    var ti = 0, score = 0, marks = [], streak = 0;
    for (var qi = 0; qi < q.length; qi++) {
      var found = t.indexOf(q[qi], ti);
      if (found === -1) return null;
      streak = (found === ti) ? streak + 1 : 1;
      score += streak * 2 + (found === 0 ? 4 : 0) + (t[found - 1] === ' ' ? 3 : 0);
      marks.push(found);
      ti = found + 1;
    }
    score -= (t.length - q.length) * 0.05;  // prefer shorter targets
    return { score: score, marks: marks };
  }

  function highlight(label, marks) {
    var out = '', set = {};
    (marks || []).forEach(function (i) { set[i] = true; });
    for (var i = 0; i < label.length; i++) {
      out += set[i] ? '<mark>' + esc(label[i]) + '</mark>' : esc(label[i]);
    }
    return out;
  }

  el.switcherInput.addEventListener('input', function () {
    var q = el.switcherInput.value;
    renderSwitcherResults(q, null);
    if (state.swSearchTimer) clearTimeout(state.swSearchTimer);
    if (q.trim().length >= 2) {
      state.swSearchTimer = setTimeout(function () {
        var seq = ++state.swSearchSeq;
        if (!state.swCounted) { state.swCounted = true; count('kn_search'); }   // once per opening, no text
        api('/search?q=' + encodeURIComponent(q.trim()) + '&limit=8').then(function (res) {
          if (seq !== state.swSearchSeq || !state.switcherOpen) return;
          if (el.switcherInput.value === q) renderSwitcherResults(q, res || {});
        }).catch(function () { /* keep local results */ });
      }, 220);
    }
  });

  function renderSwitcherResults(q, apiRes) {
    q = str(q).trim();
    var items = [];

    // local fuzzy topic matches
    var matches = [];
    state.topics.forEach(function (t) {
      var m = fuzzy(q, str(t.label));
      if (m) matches.push({ t: t, m: m });
    });
    matches.sort(function (a, b) { return b.m.score - a.m.score || byLabel(a.t, b.t); });
    matches.slice(0, q ? 8 : 12).forEach(function (x) {
      items.push({ kind: 'topic', slug: x.t.slug, label: str(x.t.label), marks: x.m.marks,
        meta: num(x.t.project_count) + ' projects' });
    });

    // API project results (second section)
    var projects = apiRes ? arr(apiRes.projects) : [];
    projects.forEach(function (p) {
      if (!p) return;
      items.push({ kind: 'project', url: str(p.url), label: str(p.title || ('Project ' + p.id)),
        source: str(p.source), meta: [p.institution, p.snippet].filter(Boolean).join(' \u00b7 ') });
    });
    // also merge API topic hits that local fuzzy missed
    if (apiRes) {
      arr(apiRes.topics).forEach(function (t) {
        if (!t || !t.slug) return;
        if (items.some(function (i) { return i.kind === 'topic' && i.slug === t.slug; })) return;
        items.push({ kind: 'topic', slug: t.slug, label: str(t.label || humanize(t.slug)), marks: [],
          meta: str(t.snippet || '') });
      });
    }

    state.swItems = items;
    state.swSelected = 0;

    if (!items.length) {
      el.switcherResults.innerHTML = '<div class="sw-empty">' + (q ? 'No matches for “' + esc(q) + '”.' : 'No topics loaded.') + '</div>';
      return;
    }

    var h = '', lastKind = '';
    items.forEach(function (it, i) {
      if (it.kind !== lastKind) {
        h += '<div class="sw-section">' + (it.kind === 'topic' ? 'Topics' : 'Projects') + '</div>';
        lastKind = it.kind;
      }
      var icon = it.kind === 'topic'
        ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>';
      h += '<button class="sw-item' + (i === state.swSelected ? ' selected' : '') + '" type="button" data-i="' + i + '">' +
        '<span class="sw-icon">' + icon + '</span>' +
        '<span class="sw-main"><span class="sw-label">' + (it.marks && it.marks.length ? highlight(it.label, it.marks) : esc(it.label)) + '</span>' +
        (it.meta ? '<span class="sw-snippet">' + esc(it.meta) + '</span>' : '') + '</span>' +
        (it.kind === 'project' ? sourceBadge(it.source) : '') +
        '</button>';
    });
    el.switcherResults.innerHTML = h;
  }

  function swMove(delta) {
    if (!state.swItems.length) return;
    state.swSelected = (state.swSelected + delta + state.swItems.length) % state.swItems.length;
    var nodes = el.switcherResults.querySelectorAll('.sw-item');
    nodes.forEach(function (n, i) { n.classList.toggle('selected', i === state.swSelected); });
    var sel = nodes[state.swSelected];
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }

  function swActivate(i) {
    var it = state.swItems[i];
    if (!it) return;
    closeSwitcher();
    if (it.kind === 'topic') openTopic(it.slug);
    else if (it.url) window.open(it.url, '_blank', 'noopener');
  }

  el.switcherResults.addEventListener('click', function (e) {
    var item = e.target.closest('.sw-item');
    if (item) swActivate(Number(item.getAttribute('data-i')));
  });

  document.addEventListener('keydown', function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      state.switcherOpen ? closeSwitcher() : openSwitcher();
      return;
    }
    if (!state.switcherOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); closeSwitcher(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); swMove(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); swMove(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); swActivate(state.swSelected); }
  });

  /* ============================================================
     SIDEBAR TOGGLING (desktop collapse / narrow overlay)
     ============================================================ */
  function isNarrow() { return window.matchMedia('(max-width: 1100px)').matches; }

  el.sidebarToggle.addEventListener('click', function () {
    if (isNarrow()) {
      var open = !el.sidebar.classList.contains('overlay-open');
      el.sidebar.classList.toggle('overlay-open', open);
      el.sidebarScrim.hidden = !open;
    } else {
      el.sidebar.classList.toggle('collapsed');
    }
  });
  function closeSidebarOverlay() {
    if (isNarrow()) {
      el.sidebar.classList.remove('overlay-open');
      el.sidebarScrim.hidden = true;
    }
  }
  el.sidebarClose.addEventListener('click', closeSidebarOverlay);
  el.sidebarScrim.addEventListener('click', closeSidebarOverlay);

  el.brand.addEventListener('click', function () { goHome(); closeSidebarOverlay(); });
  el.brand.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); } });

  var navFinder = $('#nav-funding-finder');
  if (navFinder) navFinder.addEventListener('click', function () { openFinder(); closeSidebarOverlay(); });

  /* ============================================================
     SIGN-IN: the hub's own (app.js). The gate's button opens the hub's sign-in dialog;
     the hub header shows who is signed in and offers sign-out.
     ============================================================ */
  var gateBtn = el.authGate.querySelector('.auth-link');
  if (gateBtn) gateBtn.addEventListener('click', function () {
    if (window.SFR && window.SFR.openDialog) window.SFR.openDialog();
  });

  /* ============================================================
     BOOT
     ============================================================ */
  function boot() {
    el.content.innerHTML = '<div class="state-block"><div class="spinner"></div>Loading Radicle…</div>';
    api('/topics').then(function (topics) {
      state.topics = arr(topics).filter(function (t) { return t && t.slug; });
      state.topics.forEach(function (t) {
        t.label = str(t.label) || humanize(t.slug);
        state.topicMap[t.slug] = t;
      });
      buildTree('');
      restoreTabs();
      // refresh restored tab labels from live topic list
      state.tabs.forEach(function (t) { t.label = labelFor(t.slug); });

      var m = location.hash.match(/^#\/topic\/(.+)$/);
      if (/^#\/funding-finder$/.test(location.hash)) {
        openFinder();
      } else if (m) {
        openTopic(decodeURIComponent(m[1]));
      } else {
        state.activeSlug = null;
        render();
      }
    }).catch(function (err) {
      if (err.message === 'unauthorized') return;
      el.content.innerHTML = '<div class="state-block">Could not load topics (' + esc(err.message) + ').<br><br>' +
        '<button class="wikilink" type="button" onclick="location.reload()">Reload</button></div>';
    });
  }

  var booted = false;
  function onSession(sess) {
    var changed = (sess && sess.user && sess.user.id) !== (session && session.user && session.user.id);
    session = sess;
    if (!sess) {
      state.topics = []; state.topicMap = {}; state.articleCache = {}; state.graphData = null;
      el.tree.innerHTML = ''; el.content.innerHTML = ''; booted = false;
      showGate('signin');
      return;
    }
    if (changed || !booted) { el.authGate.hidden = true; booted = true; state.articleCache = {}; boot(); }
  }
  document.addEventListener('sfr:session', function (e) { onSession(e.detail.session); });
  // the first announcement can come before this script runs: ask directly as well
  if (window.SFR && window.SFR.sb) {
    window.SFR.sb.auth.getSession().then(function (r) { if (!booted) onSession(r.data.session); });
  } else {
    showGate('signin');
  }
})();
