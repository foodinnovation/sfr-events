/* SFR event calendar: filters, sign-in and presentation access. No tracking, no cookies;
   the only stored item is the Supabase sign-in session in this browser's localStorage. */
(function () {
  "use strict";
  var cfg = window.SFR_EVENTS || {};
  var FN = cfg.supabaseUrl + "/functions/v1/deck";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function toast(msg) {
    var t = document.createElement("div");
    t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  /* ------------------------------------------------------------------ filters (index) */
  var filters = $("#filters");
  if (filters) {
    var state = { kind: "all", ig: "", q: "" };
    var params = new URLSearchParams(location.search);
    if (params.get("type")) state.kind = params.get("type");
    if (params.get("group")) state.ig = params.get("group");
    if (params.get("q")) state.q = params.get("q");

    var apply = function () {
      $$(".chip", filters).forEach(function (c) {
        var on = c.dataset.kind === state.kind;
        c.classList.toggle("is-on", on); c.setAttribute("aria-pressed", on ? "true" : "false");
      });
      $("#f-ig").value = state.ig; $("#f-q").value = state.q;
      var q = state.q.trim().toLowerCase();
      $$(".item").forEach(function (li) {
        var ok = (state.kind === "all" || li.dataset.kind === state.kind) &&
          (!state.ig || (" " + li.dataset.igs + " ").indexOf(" " + state.ig + " ") >= 0) &&
          (!q || li.dataset.search.indexOf(q) >= 0);
        li.hidden = !ok;
      });
      $$(".year").forEach(function (y) { y.hidden = !$$(".item:not([hidden])", y).length; });
      [["#upcoming", ".item:not([hidden])"], ["#archive", ".item:not([hidden])"]].forEach(function (p) {
        var box = $(p[0]); if (!box) return;
        var empty = box.parentNode.querySelector(".empty");
        if (empty) empty.hidden = $$(p[1], box).length > 0;
      });
      var u = new URLSearchParams();
      if (state.kind !== "all") u.set("type", state.kind);
      if (state.ig) u.set("group", state.ig);
      if (state.q) u.set("q", state.q);
      history.replaceState(null, "", location.pathname + (u.toString() ? "?" + u : "") + location.hash);
    };
    $$(".chip", filters).forEach(function (c) {
      c.addEventListener("click", function () { state.kind = c.dataset.kind; apply(); });
    });
    $("#f-ig").addEventListener("change", function (e) { state.ig = e.target.value; apply(); });
    $("#f-q").addEventListener("input", function (e) { state.q = e.target.value; apply(); });
    apply();
  }

  /* ------------------------------------------------------------------ share */
  $$("[data-share]").forEach(function (b) {
    b.addEventListener("click", function () {
      var url = location.origin + location.pathname;
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast("Link copied"); });
      else prompt("Copy this link:", url);
    });
  });

  /* ------------------------------------------------------------------ sign-in */
  if (!window.supabase || !cfg.supabaseUrl) return;
  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.key, {
    auth: { flowType: "implicit", persistSession: true, detectSessionInUrl: true, autoRefreshToken: true }
  });
  var dialog = $("#signin"), msg = $("#signin-message");
  var here = function () { return location.origin + location.pathname; };
  var say = function (text, isError) { msg.textContent = text || ""; msg.classList.toggle("error", !!isError); };
  var friendly = function (err) {
    var m = (err && (err.message || err.error_description)) || "Something went wrong. Please try again.";
    if (/rate limit|security purposes/i.test(m)) return "Please wait a minute before requesting another link.";
    if (/expired|invalid/i.test(m) && /token|otp|code/i.test(m)) return "This code is not valid or has expired. Request a new link.";
    return m;
  };
  var openDialog = function () {
    $("#signin-email").hidden = false; $("#signin-code").hidden = true; say("");
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
  };

  $("#signin-ms").addEventListener("click", function () {
    say("Opening Microsoft sign-in ...");
    sb.auth.signInWithOAuth({ provider: "azure", options: { scopes: "email", redirectTo: here() } })
      .then(function (r) { if (r.error) say(friendly(r.error), true); });
  });

  var pendingEmail = "";
  $("#signin-email").addEventListener("submit", function (ev) {
    ev.preventDefault();
    pendingEmail = $("#signin-address").value.trim().toLowerCase();
    say("Sending ...");
    sb.auth.signInWithOtp({ email: pendingEmail, options: { emailRedirectTo: here(), shouldCreateUser: true } })
      .then(function (r) {
        if (r.error) { say(friendly(r.error), true); return; }
        $("#signin-sent-to").textContent = pendingEmail;
        $("#signin-email").hidden = true; $("#signin-code").hidden = false; say("");
        $("#signin-otp").focus();
      });
  });

  $("#signin-code").addEventListener("submit", function (ev) {
    ev.preventDefault();
    say("Checking ...");
    sb.auth.verifyOtp({ email: pendingEmail, token: $("#signin-otp").value.replace(/\D/g, ""), type: "email" })
      .then(function (r) { if (r.error) say(friendly(r.error), true); else { say(""); dialog.close(); } });
  });

  /* Errors that come back in the URL after a link or the Microsoft sign-in, e.g. from the account check */
  (function () {
    var h = new URLSearchParams(location.hash.replace(/^#/, "") || location.search);
    var desc = h.get("error_description");
    if (desc) {
      openDialog(); say(desc.replace(/\+/g, " "), true);
      history.replaceState(null, "", location.pathname + location.search.replace(/[?&]error[^&]*/g, ""));
    }
  })();

  /* ------------------------------------------------------------------ account and decks */
  var access = null;

  function call(params, session) {
    return fetch(FN + "?" + params, { headers: { Authorization: "Bearer " + session.access_token } })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); });
  }

  function renderAccount(session) {
    var box = $("#account");
    if (!session) {
      box.innerHTML = '<button class="btn btn-secondary btn-sm" id="signin-open" type="button">Sign in</button>';
      $("#signin-open").addEventListener("click", openDialog);
      return;
    }
    var label = { staff: "Staff", member: "Member", participant: "Participant", none: "No access" }[access && access.access] || "";
    box.innerHTML = '<span class="who"></span><button class="btn btn-ghost btn-sm" id="signout" type="button">Sign out</button>';
    $(".who", box).innerHTML = (label ? "<strong></strong> &middot; " : "") + "<span></span>";
    if (label) $(".who strong", box).textContent = label;
    $(".who span", box).textContent = session.user.email;
    $("#signout").addEventListener("click", function () { sb.auth.signOut(); });
  }

  function renderDecks(session) {
    var sec = $("#presentations"); if (!sec) return;
    var eventId = Number(sec.dataset.event);
    var note = $(".access-note", sec);
    var allowed = !!(session && access && (access.events === "all" ||
      (Array.isArray(access.events) && access.events.indexOf(eventId) >= 0)));
    $$(".deck-open", sec).forEach(function (b) {
      b.disabled = !session || !allowed;
      b.classList.toggle("is-open", allowed);
      $(".label", b).textContent = !session ? "Sign in to open" : allowed ? "Open" : "Not available";
    });
    if (session && !allowed) {
      note.textContent = "Your account has no access to this meeting's presentations. They are available to members and to registered participants of this meeting.";
      note.classList.remove("ok");
    } else if (allowed) {
      note.textContent = "You have access to these presentations. They open in your browser; the viewer also lets you download the file.";
      note.classList.add("ok");
    }
  }

  $$(".deck-open").forEach(function (b) {
    b.addEventListener("click", function () {
      sb.auth.getSession().then(function (r) {
        var s = r.data.session; if (!s) { openDialog(); return; }
        var win = window.open("", "_blank");   // opened now, so pop-up blockers allow it
        $(".label", b).textContent = "Opening ...";
        call("id=" + encodeURIComponent(b.dataset.deck), s).then(function (res) {
          $(".label", b).textContent = "Open";
          if (res.status === 200 && res.body.url) {
            if (win) win.location = res.body.url; else location.href = res.body.url;
          } else {
            if (win) win.close();
            toast(res.status === 403 ? "No access to this presentation." :
                  res.status === 401 ? "Please sign in again." : "The file is not available right now.");
          }
        }).catch(function () { if (win) win.close(); toast("The file is not available right now."); });
      });
    });
  });

  function refresh(session) {
    if (!session) { access = null; renderAccount(null); renderDecks(null); return; }
    call("me=1", session).then(function (res) {
      access = res.status === 200 ? res.body : null;
      renderAccount(session); renderDecks(session);
    }).catch(function () { access = null; renderAccount(session); renderDecks(session); });
  }

  sb.auth.onAuthStateChange(function (event, session) {
    if (event === "SIGNED_IN" && dialog.open) dialog.close();
    refresh(session);
  });
  sb.auth.getSession().then(function (r) { refresh(r.data.session); });
})();
