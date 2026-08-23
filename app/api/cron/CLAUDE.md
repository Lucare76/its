## Cron jobs

Cron endpoints live in `app/api/cron/`. Register them in `vercel.json`:
```json
{ "path": "/api/cron/my-job", "schedule": "0 8 * * *" }
```
Vercel Hobby plan limits: max 2 cron jobs (currently worked around by scheduling multiple jobs at the same time and re-routing within a single handler — or by keeping within the free tier limit).
