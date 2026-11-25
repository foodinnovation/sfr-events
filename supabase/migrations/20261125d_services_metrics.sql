-- Services page (25.11.2026): count question choices, opened services and their buttons (svc_click,
-- ref = "question: <id>", "service: <key>", "cta: <key>" or "next: <key>"). The 1:1 calendar opened
-- there is booking_open with ref "services" (on the home page ref "home").
alter table events.metric drop constraint if exists metric_kind_check;
alter table events.metric add constraint metric_kind_check check (kind in (
  'view', 'register', 'ad_view', 'ad_click', 'mail_click', 'search', 'filter',
  'kn_topic', 'kn_search', 'kn_finder', 'home_click', 'booking_open', 'svc_click'));
