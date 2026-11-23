# sfr-events

The Swiss Food Research event calendar: upcoming events, the archive back to 2015, and the
presentation decks for members and participants.

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

## Layout

* `sync/rules.py`: business rules (types, publishing, access statuses, matching)
* `sync/monday.py`: reads the two monday boards (read-only)
* `sync/translate.py`: English translation via the Claude API
* `sync/run.py`: the sync itself
* `web/`: page build (`build.py`) and static assets (styles, script, logo, fonts)
* `supabase/migrations/`: the `events` schema and access functions
* `supabase/functions/`: `deck` (access check, SharePoint link) and `send-email` (sign-in emails from contact@)
* `docs/setup-sign-in.md`: one-off sign-in setup (Entra, Exchange, Supabase)
