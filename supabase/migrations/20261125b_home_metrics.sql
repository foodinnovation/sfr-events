-- Hub home page (25.11.2026): count clicks on its buttons (home_click, ref = button[: event slug or story id])
-- and how often the Calendly calendar for the free 1:1 is shown (booking_open). Same rules as the other counts.
alter table events.metric drop constraint if exists metric_kind_check;
alter table events.metric add constraint metric_kind_check check (kind in (
  'view', 'register', 'ad_view', 'ad_click', 'mail_click', 'search', 'filter',
  'kn_topic', 'kn_search', 'kn_finder', 'home_click', 'booking_open'));
