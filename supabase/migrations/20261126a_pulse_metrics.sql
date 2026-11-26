-- Pulse in the statistics (26.11.2026): count stories opened (pl_story, ref = "<story id>|<title>"),
-- clicks to an original report (pl_source, ref = "<domain>|<story id>|<title>"), Useful votes switched
-- on (pl_vote, ref = "<story id>|<title>"), filters (pl_filter: "group: ...", "region: ...", "sort: ...")
-- and search terms (pl_search). Page views of /pulse/ are already counted as view.
alter table events.metric drop constraint if exists metric_kind_check;
alter table events.metric add constraint metric_kind_check check (kind in (
  'view', 'register', 'ad_view', 'ad_click', 'mail_click', 'search', 'filter',
  'kn_topic', 'kn_search', 'kn_finder', 'home_click', 'booking_open', 'svc_click',
  'pl_story', 'pl_source', 'pl_vote', 'pl_filter', 'pl_search'));
