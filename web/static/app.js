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

  /* ------------------------------------------------------------------ ads (index) */
  /* One ad in the upcoming list (config/ads.json): members and staff see a service, matched to
     the Innovation Group filter or a general one; everyone else the membership ad. */
  var adGroup = "", adRole = "public", adPick = null;
  function placeAd() {
    var list = $("#upcoming"); if (!list) return;
    var ads = $$(".ad", list); if (!ads.length) return;
    var choice = null;
    if (adRole === "members") {
      if (adGroup) choice = ads.filter(function (a) {
        return (" " + (a.dataset.groups || "") + " ").indexOf(" " + adGroup + " ") >= 0;
      })[0] || null;
      if (!choice) {
        var gen = ads.filter(function (a) { return a.hasAttribute("data-general"); });
        if (!adPick && gen.length) adPick = gen[Math.floor(Math.random() * gen.length)];
        choice = adPick;
      }
    } else {
      choice = ads.filter(function (a) { return a.dataset.audience === "public"; })[0] || null;
    }
    var shown = $$(".item:not([hidden])", list);
    ads.forEach(function (a) { a.hidden = true; });
    if (!choice || !shown.length) return;
    var slot = parseInt(list.dataset.adSlot, 10) || 3;
    var after = shown[Math.min(slot - 1, shown.length) - 1];
    after.parentNode.insertBefore(choice, after.nextSibling);
    choice.hidden = false;
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
      adGroup = state.ig; placeAd();
    };
    $$(".chip", filters).forEach(function (c) {
      c.addEventListener("click", function () { state.kind = c.dataset.kind; apply(); });
    });
    $("#f-ig").addEventListener("change", function (e) { state.ig = e.target.value; apply(); });
    $("#f-q").addEventListener("input", function (e) { state.q = e.target.value; apply(); });
    apply();
  }

  /* ------------------------------------------------------------------ email buttons */
  /* A mailto button does nothing when the browser has no mail app set up (Outlook or Gmail in
     the browser, for example). The button still tries the mail app, and a small panel offers the
     same email in Outlook on the web or Gmail, or copies it. */
  $$('a.btn[href^="mailto:"]').forEach(function (a) {
    a.addEventListener("click", function () {
      var u = new URL(a.href), to = decodeURIComponent(u.pathname);
      var subject = u.searchParams.get("subject") || "", body = u.searchParams.get("body") || "";
      var q = function (o) { return Object.keys(o).filter(function (k) { return o[k]; })
        .map(function (k) { return k + "=" + encodeURIComponent(o[k]); }).join("&"); };
      var panel = a.parentNode.querySelector(".mail-alt");
      if (!panel) {
        panel = document.createElement("div");
        panel.className = "mail-alt";
        panel.innerHTML = '<p>No email window opened? Write it here instead:</p>' +
          '<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" data-k="outlook">Outlook on the web</a>' +
          '<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" data-k="gmail">Gmail</a>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-k="copy">Copy address and text</button>';
        a.insertAdjacentElement("afterend", panel);
        $('[data-k="outlook"]', panel).href = "https://outlook.office.com/mail/deeplink/compose?" + q({ to: to, subject: subject, body: body });
        $('[data-k="gmail"]', panel).href = "https://mail.google.com/mail/?" + q({ view: "cm", to: to, su: subject, body: body });
        $('[data-k="copy"]', panel).addEventListener("click", function () {
          var text = "To: " + to + (subject ? "\nSubject: " + subject : "") + (body ? "\n\n" + body : "");
          if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast("Copied: " + to); });
          else prompt("Copy this:", text);
        });
      }
      panel.hidden = false;
    });
  });

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
    $$(".deck-download", sec).forEach(function (b) { b.hidden = !allowed; });
    if (session && !allowed) {
      note.textContent = "Your account has no access to this meeting's presentations. They are available to members and to registered participants of this meeting.";
      note.classList.remove("ok");
    } else if (allowed) {
      note.textContent = "You have access to these presentations. Open shows them in your browser; Download saves the file.";
      note.classList.add("ok");
    }
  }

  function failed(res) {
    toast(res && res.status === 403 ? "No access to this presentation." :
          res && res.status === 401 ? "Please sign in again." : "The file is not available right now.");
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
          } else { if (win) win.close(); failed(res); }
        }).catch(function () { if (win) win.close(); failed(null); });
      });
    });
  });

  $$(".deck-download").forEach(function (b) {
    b.addEventListener("click", function () {
      sb.auth.getSession().then(function (r) {
        var s = r.data.session; if (!s) { openDialog(); return; }
        $(".label", b).textContent = "Preparing ...";
        call("id=" + encodeURIComponent(b.dataset.deck) + "&mode=download", s).then(function (res) {
          $(".label", b).textContent = "Download";
          if (res.status === 200 && res.body.url) {
            var a = document.createElement("a");   // the link is short-lived and pre-authorised
            a.href = res.body.url; a.rel = "noopener";
            if (res.body.filename) a.download = res.body.filename;
            document.body.appendChild(a); a.click(); a.remove();
          } else failed(res);
        }).catch(function () { $(".label", b).textContent = "Download"; failed(null); });
      });
    });
  });

  /* ------------------------------------------------------------------ registration */
  // ti.to and Eventbrite scripts load only when a visitor asks for the form, so a plain visit
  // to the calendar makes no request to third parties.
  var reg = $("#registration");
  function loadScript(src) {
    return new Promise(function (ok, fail) {
      var el = document.createElement("script");
      el.src = src; el.async = true; el.onload = ok; el.onerror = fail;
      document.head.appendChild(el);
    });
  }
  function openRegistration() {
    if (!reg) return;
    reg.scrollIntoView({ behavior: "smooth", block: "start" });
    var box = $(".reg-widget", reg);
    if (reg.dataset.loaded) return;
    reg.dataset.loaded = "1";
    box.hidden = false;
    box.innerHTML = '<p class="muted">Loading the registration form ...</p>';
    var ref = reg.dataset.ref, done;
    if (reg.dataset.provider === "tito") {
      done = loadScript("https://js.tito.io/v2").then(function () {
        box.innerHTML = "";
        var w = document.createElement("tito-widget");
        w.setAttribute("event", ref);
        box.appendChild(w);
      });
    } else {
      done = loadScript("https://www.eventbrite.com/static/widgets/eb_widgets.js").then(function () {
        box.innerHTML = '<div id="eb-widget"></div>';
        window.EBWidgets.createWidget({ widgetType: "checkout", eventId: ref,
          iframeContainerId: "eb-widget", iframeContainerHeight: 640 });
      });
    }
    done.then(function () {
      var first = $(".reg-actions .btn-primary", reg); if (first) first.hidden = true;
    }).catch(function () {
      delete reg.dataset.loaded;
      box.innerHTML = '<p class="form-message error">The form could not be loaded. Please use the link to register directly.</p>';
    });
  }
  $$("[data-register]").forEach(function (b) {
    b.addEventListener("click", function (ev) { ev.preventDefault(); openRegistration(); });
  });
  if (reg && location.hash === "#register") openRegistration();

  /* other parts of the hub (the knowledge tab) listen for sign-in changes */
  window.SFR = { sb: sb, openDialog: openDialog, toast: toast };
  function announce(session) {
    adRole = session && access && (access.access === "member" || access.access === "staff") ? "members" : "public";
    placeAd();
    document.dispatchEvent(new CustomEvent("sfr:session", { detail: { session: session, access: access } }));
  }

  function refresh(session) {
    if (!session) { access = null; renderAccount(null); renderDecks(null); announce(null); return; }
    call("me=1", session).then(function (res) {
      access = res.status === 200 ? res.body : null;
      renderAccount(session); renderDecks(session); announce(session);
    }).catch(function () { access = null; renderAccount(session); renderDecks(session); announce(session); });
  }

  sb.auth.onAuthStateChange(function (event, session) {
    if (event === "SIGNED_IN" && dialog.open) dialog.close();
    refresh(session);
  });
  sb.auth.getSession().then(function (r) { refresh(r.data.session); });
})();
