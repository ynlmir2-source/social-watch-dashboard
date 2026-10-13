# Social Watch Dashboard

Social Watch is a Railway-hosted dashboard for Discord keyword monitoring, alert history, rule management, and Home Assistant / Google Nest announcements.

## Features

- Authenticated dashboard with a persistent PostgreSQL alert inbox.
- Overview counts and 7-day activity.
- Search and filter alerts; mark individual/all alerts read or delete them.
- Create a dashboard-only test event.
- Manage up to 100 keyword phrases, priority, and enabled/disabled state.
- Configure Discord alert-channel delivery.
- Configure Home Assistant / Nest announcement delivery, priority threshold, recurring quiet hours, and timezone.
- Dashboard refresh preferences and optional browser notifications.
- Integration health cards for the dashboard, Discord bot, and Home Assistant webhook path.
- The Discord bot securely fetches rules and automation settings from `/api/bot-config`.

## Railway environment variables

Set these on the **dashboard service**:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Railway PostgreSQL connection reference |
| `DASHBOARD_USERNAME` | Dashboard login username |
| `DASHBOARD_PASSWORD` | Dashboard login password |
| `DASHBOARD_INGEST_KEY` | Shared secret for trusted bot requests |
| `SESSION_SECRET` | Secret used to sign dashboard sessions |

The Discord bot service needs `DISCORD_TOKEN`, `ALERT_CHANNEL_ID`, `DASHBOARD_URL`, and the same `DASHBOARD_INGEST_KEY`. To announce alerts on Nest Hub, it also needs `HOME_ASSISTANT_WEBHOOK_URL`. Keep all secrets in Railway Variables; never commit them into this repository.

## API routes

- `GET /health` — basic service and database health.
- `POST /api/alerts` — authenticated ingestion endpoint for a trusted alert producer.
- `GET /api/settings` / `PUT /api/settings` — authenticated dashboard settings.
- `GET /api/bot-config` — keyword and delivery configuration for the trusted bot; requires the bearer ingestion key.
- `POST /api/integrations/heartbeat` — trusted integration check-in.
- `GET /api/integrations` — current integration status for signed-in users.
- `GET /api/dashboard/summary` — counts and seven-day activity.
- `GET /api/alerts` — authenticated alert inbox.
- `PATCH /api/alerts/:id/read`, `POST /api/alerts/bulk-read`, `DELETE /api/alerts/:id` — inbox actions.
- `POST /api/alerts/test` — creates a dashboard-only test record; it does **not** trigger the Nest Hub.
- `GET /api/config` — backwards-compatible active keyword list.

Dashboard settings are stored in PostgreSQL and are synced by the Discord bot about once per minute. Existing alert rows are retained when the dashboard is updated; startup migrations add the read-status field and settings/integration tables if missing.

## Supported social sources

Discord is the implemented monitor in this repository's companion bot. Reddit, YouTube, X, Instagram, and TikTok are shown as future source integrations in the UI, but are **not monitoring yet**. Each needs a supported API/integration, credentials/permissions, and a running adapter that forwards events to the ingestion endpoint.

## Google Nest / Home Assistant

The bot posts eligible alerts to the private Home Assistant webhook URL stored as `HOME_ASSISTANT_WEBHOOK_URL`. In Home Assistant, the automation should be configured to accept the webhook and call the Google Assistant SDK notification action. Announcement priority and quiet hours are managed from the dashboard and synchronized to the bot.

## Run locally

```bash
npm install
npm start
```

The required environment variables and a reachable PostgreSQL database must be configured before starting the application.
