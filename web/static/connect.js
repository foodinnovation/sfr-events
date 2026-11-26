/* Radicle connector: the sign-in step. radicle-mcp/authorize sends people here with ?req=<signed request>.
   They sign in with the hub login (app.js), see which app asks and where it returns, and allow or cancel.
   connect.js then posts the request and the hub session to radicle-mcp/approve and follows the answer
   back to the AI app. The request is kept in localStorage for 20 minutes so that it survives an email
   sign-in link that opens a new tab; it is removed when the connection is allowed or cancelled. */
(function () {
  "use strict";
  var root = document.getElementById("connect");
  if (!root) return;
  var KEY = "sfr-radicle-connect";
  var MCP = root.getAttribute("data-mcp");
  var box = document.getElementById("cx-approve"), body = document.getElementById("cx-body"),
      title = document.getElementById("cx-title"), guide = document.getElementById("cx-guide");
  var KNOWN = /(^|\.)(claude\.ai|claude\.com|anthropic\.com|chatgpt\.com|openai\.com|mistral\.ai)$/i;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function payload(token) {
    try {
      var p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      var bin = atob(p + "===".slice((p.length + 3) % 4));
      return JSON.parse(decodeURIComponent(Array.prototype.map.call(bin, function (c) {
        return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
      }).join("")));
    } catch (e) { return null; }
  }
  function store(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) { /* private mode */ } }
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }

  /* copy button on the guide */
  var copy = document.getElementById("cx-copy");
  if (copy) copy.addEventListener("click", function () {
    var t = document.getElementById("cx-url").textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { if (window.SFR) window.SFR.toast("Address copied"); });
    else prompt("Copy the connector address:", t);
  });

  /* the pending request: from the address, or from storage after an email sign-in link */
  var q = new URLSearchParams(location.search).get("req");
  if (q) { store(q); history.replaceState(null, "", location.pathname); }
  var req = q || stored();
  var info = req && payload(req);
  if (!req) return;                       // plain guide page
  box.hidden = false; guide.hidden = true;
  if (!info || !info.exp || info.exp * 1000 < Date.now()) {
    store(null);
    title.textContent = "This request has expired";
    body.innerHTML = "<p>Connection requests are valid for 20 minutes. Start again from your AI app.</p>" +
      '<p><a href="./">How to connect Radicle</a></p>';
    return;
  }

  var app = info.cn || "AI assistant", host = info.host || "unknown";
  var known = KNOWN.test(host.replace(/:\d+$/, "")) || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || / app$/.test(host);
  var busy = false;

  function show(session, access) {
    if (busy) return;
    title.textContent = "Connect Radicle to " + app;
    var who = '<p class="cx-meta"><span>App</span><strong>' + esc(app) + "</strong></p>" +
      '<p class="cx-meta"><span>Returns to</span><strong>' + esc(host) + "</strong></p>" +
      (known ? "" : '<p class="form-message error">This return address is not one of the usual AI apps. ' +
        "Only continue if you started this connection yourself.</p>");
    if (!session) {
      body.innerHTML = who + "<p>Sign in with your work address to let this app read Radicle for you.</p>" +
        '<p class="cx-actions"><button type="button" class="btn btn-primary" id="cx-signin">Sign in</button>' +
        '<button type="button" class="btn btn-ghost" id="cx-cancel">Cancel</button></p>';
      document.getElementById("cx-signin").addEventListener("click", function () { if (window.SFR) window.SFR.openDialog(); });
      document.getElementById("cx-cancel").addEventListener("click", function () { decide(null, true); });
      return;
    }
    var email = (session.user && session.user.email) || "";
    var a = access && access.access;
    if (access && a !== "member" && a !== "staff") {
      body.innerHTML = who + '<p class="form-message error">Radicle is for members of Swiss Food Research. ' + esc(email) +
        " is not a member address. Sign out and sign in with your work address, or ask us at " +
        '<a href="mailto:contact@swissfoodresearch.ch">contact@swissfoodresearch.ch</a>.</p>' +
        '<p class="cx-actions"><button type="button" class="btn btn-secondary" id="cx-out">Sign out</button>' +
        '<button type="button" class="btn btn-ghost" id="cx-cancel">Cancel</button></p>';
      document.getElementById("cx-out").addEventListener("click", function () { if (window.SFR) window.SFR.sb.auth.signOut(); });
      document.getElementById("cx-cancel").addEventListener("click", function () { decide(null, true); });
      return;
    }
    body.innerHTML = who + '<p class="cx-meta"><span>Signed in as</span><strong>' + esc(email) + "</strong></p>" +
      "<p>" + esc(app) + " will be able to <strong>read</strong> Radicle's topic articles, research gaps, research projects and " +
      "funding programmes for you. It cannot change anything. Each call is logged with your email address; you can make " +
      "200 calls a day. You can disconnect at any time in the app.</p>" +
      '<p class="cx-actions"><button type="button" class="btn btn-primary" id="cx-allow">Allow</button>' +
      '<button type="button" class="btn btn-ghost" id="cx-cancel">Cancel</button></p>';
    document.getElementById("cx-allow").addEventListener("click", function () { decide(session, false); });
    document.getElementById("cx-cancel").addEventListener("click", function () { decide(session, true); });
  }

  function decide(session, deny) {
    if (busy) return;
    busy = true;
    $$btn(true);
    fetch(MCP + "/approve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ req: req, token: session ? session.access_token : "", deny: deny })
    }).then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.status === 200 && res.body.redirect) {
          store(null);
          title.textContent = deny ? "Cancelled" : "Connected";
          body.innerHTML = "<p>" + (deny ? "Returning to " : "Radicle is connected. Returning to ") + esc(host) + " ...</p>" +
            '<p class="muted">If nothing happens, go back to ' + esc(app) + " yourself.</p>";
          location.href = res.body.redirect;
          return;
        }
        busy = false;
        if (res.body.detail === "expired") { store(null); title.textContent = "This request has expired";
          body.innerHTML = "<p>Start again from your AI app.</p>"; return; }
        if (res.body.detail === "members_only") {
          body.innerHTML = '<p class="form-message error">Radicle is for members of Swiss Food Research. ' + esc(res.body.email || "This address") +
            " is not a member address. Sign in with your work address, or write to " +
            '<a href="mailto:contact@swissfoodresearch.ch">contact@swissfoodresearch.ch</a>.</p>';
          return;
        }
        if (res.body.detail === "sign_in") { show(null, null); return; }
        $$btn(false);
        if (window.SFR) window.SFR.toast("The connection could not be made. Please try again.");
      })
      .catch(function () { busy = false; $$btn(false); if (window.SFR) window.SFR.toast("The connection could not be made. Please try again."); });
  }
  function $$btn(off) { Array.prototype.forEach.call(body.querySelectorAll("button"), function (b) { b.disabled = off; }); }

  show(null, null);
  document.addEventListener("sfr:session", function (e) { show(e.detail.session, e.detail.access); });
})();
