# Coffee ERP — Order Management (Live Build)

Production-consolidated build of the Coffee ERP order-management app:
single-file backend (`server.js`) + single-file frontend (`index.html`),
SQLite database, JWT auth. No build step, no dev dependencies at runtime.

## Run locally

```bash
npm install
cp .env.example .env   # then set JWT_SECRET
npm start              # http://localhost:3000
```

First boot seeds the workbook data (`seed-data.json`) and creates logins.

## Deploy (Render + Docker, persistent SQLite)

```bash
git init && git add -A && git commit -m "live" && git push <repo>
```

Connect the repo in Render (Blueprint deploys `render.yaml` automatically):
a 1 GB persistent disk keeps `/data/erp.db` across deploys. `JWT_SECRET`
is generated for you — copy it somewhere safe.

## Logins (change after first deploy)

| User | Password | Access |
|---|---|---|
| `admin` | `admin123` | Full access |
| `staff` | `staff123` | Daily work, no deletes/settings |

## Notes

- Health check: `GET /api/health`.
- The server must be running at 10:00 and 18:00 local time for the
  scheduled billing/EOD emails (configure SMTP + recipients in Settings).
- `Final Web App .xlsx` is the source workbook reference.
