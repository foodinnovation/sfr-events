# sfr-events

The Swiss Food Research hub at hub.swissfoodresearch.ch: a home page and three tabs.

* **Home** (`/`): the next three SFR and Innovation Group events, Pulse's top three of the week,
  a free 1:1 session with a Calendly calendar, Radicle and the newsletter. See "The home page" below.
* **Services** (`/services/`): the SFR services, found by need ("What do you need?"), with a detail
  view per service, all services by pillar and the free 1:1. See "The Services page" below.
* **Events** (`/events/`): upcoming events, the archive back to 2015, and the presentation decks for
  members and participants. One page per event at `/events/<slug>/`.
* **Radicle – Knowledge**: radicle's topic articles, the ~6,600 relevant funded projects
  and a funding finder, for members and staff only.
* **Pulse**: AI-curated agro-food news with links to the originals (staff only until opened, see below).

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

  Member domains come from the Mitglieder board (column "Email Domain", else the website), mirrored
  into `public.crm_members` by the n8n workflow "IG Wiki - CRM mirror" every Monday at 04:47. Free
  email domains (`events.free_mail_domain`: gmail.com, outlook.com, bluewin.ch, posteo.net and so on)
  never make anyone a member, even if one is entered there. Registered participants keep access to
  their event's slides with the exact address they registered with, free email or not.

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

`web/build.py` writes the static site from Supabase after each sync: the home page (`/`), the
listing with filters (type, Innovation Group, search) at `/events/`, one page per SFR and Innovation
Group event at `/events/<slug>/` (programme, presentations), and the archive back to 2015. Partner events link to the partner's page.
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

## Pulse

The tab (`/pulse/`) shows AI-curated agro-food news: an English summary of each story, the original title
and a link to every report, sorted by Innovation Group and region, with an "Added today / n days ago" note.
Members can mark a story useful (one vote each, withdrawable). There are no comments.

* **Stories** come from schema `pulse` in ig-wiki, filled every three hours by
  [foodinnovation/sfr-pulse](https://github.com/foodinnovation/sfr-pulse) (open feeds and the free newsletters
  at newsletters@). The page is an empty shell; the edge function `pulse` serves the stories
  (`pulse.hub_stories`: relevant items only, newsletter items only with a checked link, original title,
  no click-trackers and no mailbox ids in links) and records votes (`pulse.hub_vote`, table `pulse.vote`).
* **Staff only until opened.** While `config/pulse.json` has `"public": false` the tab is hidden for everyone
  but signed-in staff and the page is not indexed; while `pulse.setting` `public` is not `true` the function
  serves staff only. To open Pulse to everyone, do both:
  `update pulse.setting set value = 'true', updated_at = now() where key = 'public';` in the ig-wiki SQL
  editor, and `"public": true` in `config/pulse.json` (a push republishes the site).
* **How much Pulse shows.** Each item has a 0-100 score inside its 1-5 rating (3 = 40-59, 4 = 60-79, 5 = 80-100).
  The hub shows items at or above `pulse.setting` `min_score` (default 60, the same as "rated 4 or 5"; 50 adds the
  better half of the 3s): `update pulse.setting set value = '50', updated_at = now() where key = 'min_score';`
  takes effect on the next page load.
* Funding calls and tenders appear as a members-only teaser for now.

## Layout

* `sync/rules.py`: business rules (types, publishing, access statuses, matching)
* `sync/monday.py`: reads the two monday boards (read-only)
* `sync/translate.py`: English translation via the Claude API
* `sync/run.py`: the sync itself
* `web/`: page build (`build.py`) and static assets (styles, scripts incl. `home.js`, logo, fonts)
* `config/`: `home.json` (home page), `ads.json` (events-list ads), `logo_wall.json`, `pulse.json`
* `supabase/migrations/`: the `events` schema and access functions
* `sync/knowledge.py`: copy for the knowledge tab (radicle, Funding Schemes, contacts)
* `supabase/functions/`: `deck` (access check, SharePoint link), `knowledge` (knowledge tab API), `pulse` (Pulse tab),
  `sync-trigger` (starts the sync) and `send-email` (sign-in emails from contact@)
* `docs/setup-sign-in.md`: one-off sign-in setup (Entra, Exchange, Supabase)

## The home page

`/` is the hub's front door (`home_page` in `web/build.py`, script `web/static/home.js`). Text and
links sit in `config/home.json`; a push republishes the site in about 10 minutes.

* **Hero**: headline, lead line and two buttons ("Book a free 1:1", "See upcoming events"). The
  picture is a Design System 2026 visual from `web/static/img/ig-art` (`hero.image`, now `farming`).
* **Next events**: the next three SFR and Innovation Group events with a date. Partner events are
  only on `/events/`. Register appears when the event has a sign-up link, otherwise Details.
* **Pulse: top 3 this week**: the three best-scored stories of the last 7 days from the edge function
  `pulse`. The block shows only when the function serves the visitor, so staff only until Pulse opens
  (see Pulse below); the events column then takes the full width.
* **Free 1:1 session**: the Calendly page in `booking.url`. Calendly loads only after a click on
  "Show available slots" (an iframe, no Calendly script), so the hub stays free of third-party
  content and cookies until the visitor asks. "Open in Calendly" links out.
* **Radicle – Knowledge** card for everyone: members and staff get "Open Radicle", others "Become a
  member" and a sign-in link. **Newsletter**: a link to the sign-up form in `newsletter.url`.
* **Old links**: the events list used to be at `/`. Requests to `/` with `group`, `type` or `q` (the
  list's filters) are forwarded to `/events/` with the same filters.
* **Counting**: clicks on the home page's buttons (`home_click`) and the calendar being shown
  (`booking_open`) appear in the Statistics tab under "Home page". Page views of `/` before
  26 November 2026 were views of the events list.

## The Services page

`/services/` (`services_page` in `web/build.py`, script `web/static/services.js`) shows the SFR
services. Its texts are not written in this repo: the website's service finder
(`foodinnovation/sfr-service-finder`) publishes the public, English texts of the **SFR Service
Catalogue 2027** with their structure and icons, and each sync copies them into `data/services/`
(`python -m web.services --refresh data/services`). A copy is kept only when it is complete; if the
finder is unreachable or half-published, the last good copy stays. So to change a service, change the
catalogue and let the `service-finder-sync` skill update the finder; the hub follows within about
30 minutes.

* **What do you need?**: the finder's six questions; the first service of each is the best match.
  `?q=<question>&s=<service>` opens the page on a question and service.
* **Detail**: what it is, when, how it works, who it is for, financing, the main button and the next
  step. Buttons: coaching and every service without its own button lead to the free 1:1 (`#book`,
  Calendly on click); Radicle to `/knowledge/`, Innovation Groups to `/events/?type=ig`, Events to
  `/events/`, Newsletter to the form in `config/home.json`, Booster and MaaS as on the website
  (`service_cta`).
* **Your member advantages**: signed-in members and staff see the services marked
  `member_advantage`; visitors see the badges only.
* **Counting**: question choices, opened services and their buttons (`svc_click`) and the 1:1 calendar
  shown there appear in the Statistics tab under "Services page".

## Open items

* Newsletter sign-up: replace the monday form with a proper sign-up (double opt-in, straight into
  the newsletter list).
* Calendly address: the account slug is spelled `swissfoodreseach`. Renaming it breaks existing links,
  so decide before printing or mailing it widely.
* Home page: add a block on the network (member organisations, member page) once the member page exists.
* www.swissfoodresearch.ch: point the menu link to the hub's root.

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

## Usage counting and the Statistics tab

`app.js` counts a few actions without cookies or personal data and sends them in the background
(`navigator.sendBeacon`) to the edge function `metric`, which stores them in `events.metric`:
page views, home-page button clicks and the 1:1 calendar being shown, Register clicks, ads shown and clicked, email-button clicks, events-list searches and
filters, and in Radicle – Knowledge topics opened, quick searches and Funding Finder runs (no text).
Each row holds time, action, page, a short reference, role (visitor, participant, member, staff),
referring domain and mobile or not. No IP address, email address or visitor id. Browsers driven
by automation and known bots are not counted. Rows older than 13 months, and presentation-access
log entries of the same age, are deleted nightly (`events.purge_old_usage`, pg_cron
`sfr-hub-usage-purge`).

The Statistics tab (`/stats/`) is visible to signed-in staff only and reads aggregates from the
edge function `stats`, which checks staff access itself. The Privacy page (`/privacy/`) describes
all of this; keep it in step with any change.

