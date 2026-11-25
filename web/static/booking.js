/* SFR hub: the free 1:1 session. Calendly is contacted only after the visitor clicks
   "Show available slots" (an iframe; no Calendly script). Used on the home page and /services/. */
(function () {
  "use strict";
  var load = document.getElementById("cal-load");
  if (!load) return;
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function show() {
    var u = new URL(load.dataset.url);
    u.searchParams.set("embed_type", "Inline");
    u.searchParams.set("embed_domain", location.hostname);
    u.searchParams.set("hide_gdpr_banner", "1");
    u.searchParams.set("hide_event_type_details", "1");
    var box = document.getElementById("book-cal");
    box.innerHTML = '<iframe class="home-cal-frame" title="Book a free 1:1 session" src="' + esc(u.toString()) + '"></iframe>';
    box.classList.add("is-loaded");
    if (window.SFR && window.SFR.track) window.SFR.track("booking_open", location.pathname.indexOf("/services") >= 0 ? "services" : "home");
  }
  load.addEventListener("click", show);
  window.SFRBooking = { show: function () { if (document.getElementById("cal-load")) show(); } };
})();
