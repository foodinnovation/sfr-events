-- Radicle – Knowledge: keep each research gap's reason (e.g. 'unexplored'), shown on topic pages.
alter table knowledge.gap add column if not exists gap_reason text;
