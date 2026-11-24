# sfr-events

The Swiss Food Research hub (planned address: hub.swissfoodresearch.ch), with two tabs:

* **Events**: upcoming events, the archive back to 2015, and the presentation decks for
  members and participants.
* **Radicle – Knowledge**: radicle's topic articles, the ~6,600 relevant funded projects
  and a funding finder, for members and staff only.

Staff edit events in one place only: the monday board **Events Planung**. Everything else
follows from there.

## How it works

```
monday: Events Planung ─┐
monday: Events attendees ┼─► GitHub job (on change + every 30 min) ─► Supabase ig-wiki, schema "events"
SharePoint decks (wiki) ─┘                                      │
                                                               ▼
                                      static page on GitHub Pages (phase 3)
                                      deck button ─► access check ─► SharePoint download link (phase 2)
```

* **Events** come from Events Planung. The group decides the type:
  "Innovationsgruppen" and "SFR Events / co-organizing Events" are internal and appear once
  they have a date, unless Website Status is "Nicht publizieren". "Events" holds external
  events, which appear only when Website Status is "Bereit für Website".
* **Programme** comes from the subitems with status "Zugesagt".
* **Text** is translated into English automatically, once per change.
* **Past IG meetings** that were never on monday come from the IG wiki's meeting index.
* **Decks** stay on SharePoint. A deck is cleared when it sits in a folder whose name
  contains "web". Members (exact email domain of an active member) can open every cleared
  deck. Participants on the Events attendees board can open the decks of their event,
  unless they cancelled ("Not Attending", "excused") or were a no-show. Events before the
  attendees board existed are members only.
* **Attendee groups** are matched to events by the date in the group title, with the name as
  tie-breaker. Unclear cases are left unmatched for review.

## Secrets (Settings > Secrets and variables > Actions)

| Name | What |
|---|---|
| `MONDAY_TOKEN` | monday API token (read access to Events Planung and Events attendees) |
| `SUPABASE_DB_PASSWORD` | Password of the database login `events_job` (set once in the ig-wiki SQL editor with `alter role events_job with login password '...'`; to change it later, create a new role rather than rotating, because the Supabase pooler caches passwords) |
| `RADICLE_DB_PASSWORD` | Password of the read-only login `knowledge_reader` on the radicle database (set once in the radicle SQL editor with `alter role knowledge_reader with login password '...'`). Without it the knowledge tab keeps its last copy and only the funding instruments refresh |
| `ANTHROPIC_API_KEY` | Claude API key for the English translations (optional; without it texts stay in the original language) |

## Running it

* **On every change to Events Planung.** monday notifies the Supabase function `sync-trigger`
  (12 webhooks: items, columns, names, groups, archive and delete, programme subitems), which
  starts this workflow. Bursts of edits start one run: the function lets at most one start
  through every 15 seconds (shorter than the test step that runs before monday is read, so no edit is missed), and GitHub queues at most one run behind the running one. A change
  is live about four minutes later.
* **Every 30 minutes as a backstop**, at :07 and :37, by the Supabase scheduler (pg_cron job
  `sfr-events-sync`, see `supabase/scheduled/sync_schedule.sql`). It also catches changes on
  the Events attendees board, which sends no notifications. The daily health check runs the
  same way (`sfr-events-health`, 05:17 UTC).
* GitHub's own schedule is not used: it never fired for this repository.
* The function needs the Supabase secret `GITHUB_DISPATCH_TOKEN`: a fine-grained GitHub token
  for this repository only, with the single permission "Actions: read and write". When it
  expires, the sync stops; renew it and replace the secret. Status and the last starts:
  `GET https://iudsjtrdtncqqhswcnfu.supabase.co/functions/v1/sync-trigger?status=1`.
* By hand: Actions > "Sync and publish" > Run workflow. Tick "Dry run" to see the
  report without writing anything.
* Each run writes a report (matches, published events, counts) to the run summary.

Locally:

```
pip install -r requirements.txt
pytest -q                                   # unit tests
TEST_DB_URL="host=... dbname=sfrtest" pytest -q   # plus database tests on a throwaway Postgres
MONDAY_TOKEN=... SUPABASE_DB_URL=... python -m sync.run --dry-run
```

## The page

`web/build.py` writes the static page from Supabase after each sync: the listing with filters
(type, Innovation Group, search), one page per SFR and Innovation Group event (programme,
presentations), and the archive back to 2015. Partner events link to the partner's page.
Fonts and the sign-in library are bundled; the page loads nothing from third parties.
Published by the same workflow to GitHub Pages whenever something changed.

## Radicle – Knowledge

The tab's page (`/knowledge/`) is an empty shell on the public site. Its content loads after
sign-in from the Supabase function `knowledge`, which admits members (exact member domain) and
staff only; event participants are refused. The function reads schema `knowledge` in ig-wiki,
which the sync job refills from:

* radicle's Supabase copy (`wiki_articles`, `projects` with `stage_gate = 'passed'`,
  `white_spots`), through the read-only login `knowledge_reader`. Radicle's own compile step
  pushes to that copy, so the tab is as current as radicle's last pipeline run;
* the monday board Funding Schemes (1737639790) for the funding finder's programmes;
* the contact routing in `sync/knowledge.py` (names and roles only, no email addresses).

A failure here never stops the event sync: it shows as a warning on the run and in the report.

The tab runs radicle's own Obsidian-style reader (web/static/knowledge/, adapted from agro-food-intelligence src/api/static/wiki): topic tree with gap-severity dots and project counts, a tab per opened topic, Cmd+K / Ctrl+K quick switcher across topics and projects, graph view, research gaps on each topic page and the funding finder. The members-only function functions/v1/knowledge speaks radicle's wiki API through `?path=`.

## Layout

* `sync/rules.py`: business rules (types, publishing, access statuses, matching)
* `sync/monday.py`: reads the two monday boards (read-only)
* `sync/translate.py`: English translation via the Claude API
* `sync/run.py`: the sync itself
* `web/`: page build (`build.py`) and static assets (styles, script, logo, fonts)
* `supabase/migrations/`: the `events` schema and access functions
* `sync/knowledge.py`: copy for the knowledge tab (radicle, Funding Schemes, contacts)
* `supabase/functions/`: `deck` (access check, SharePoint link), `knowledge` (knowledge tab API),
  `sync-trigger` (starts the sync) and `send-email` (sign-in emails from contact@)
* `docs/setup-sign-in.md`: one-off sign-in setup (Entra, Exchange, Supabase)

## Ads on the events list

`config/ads.json` holds every ad and its switches. One ad card sits in the upcoming list
(`slot`, default 3rd place). Signed-in members and staff see a service: the one set in
`by_group` when the list is filtered to that Innovation Group, otherwise one of `general` at
random. Everyone else sees the membership ad.

* All ads off: `"enabled": false` at the top.
* One ad off: `"enabled": false` inside that ad. Groups that pointed to it fall back to the
  general services.
* Text and links: edit the ad's `label`, `headline`, `body`, `cta` and `href`. Copy comes from
  the SFR Service Catalogue 2027.

A push publishes the change in about 10 minutes.

## Member organisations attending

Upcoming event pages show the logos of the member organisations registered for the event, in
the right-hand column (`web/attending.py`, settings in `config/logo_wall.json`).

* Registrations on the Events attendees board are matched to members by exact email domain,
  the rule that gives members access to presentations. Departments sharing a domain get one
  tile. Cancellations and no-shows do not count; freemail and SFR's own domain are left out.
* Non-member organisations are only counted ("plus 20 other organisations"). No person,
  address or head count per organisation is published.
* The block shows from `min_members` (5) member organisations, at most `max_logos` (12)
  logos, and disappears once the event date has passed.
* Logos come from the Logo column of the monday board Mitglieder (the source of the SFR Design
  System 2026 member logos), downloaded at build time for upcoming events only and served from
  the hub. White logos get a dark tile. A logo that cannot be used becomes a name tile.
* To hide an organisation, add its member name or email domain to `exclude`. To switch the
  block off, set `enabled` to false.

