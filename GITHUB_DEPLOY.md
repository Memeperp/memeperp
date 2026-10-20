# GitHub Deployment Notes

## Local Run (single command)

```bash
npm ci
npm start
```

This starts `backend/server.js` on `http://localhost:8787` and also serves frontend files from the project root.

Open:
- `http://localhost:8787/` — landing page
- `http://localhost:8787/index.html`
- `http://localhost:8787/testnet.html`

## Portable Project

The app uses standard Node.js and npm. It has no hosting-platform SDK dependency.
The GitHub version includes application code, public assets, tests and deployment
documentation. Local workspace settings, assistant metadata, uploaded chat
material, review screenshots, runtime account data and secrets are excluded.
Excluded workspace files can remain locally without being part of the repository.

Configure production environment variables securely on your hosting service;
do not commit credentials. See [SECRETS_SETUP.md](SECRETS_SETUP.md) and
[.env.example](.env.example) for configuration. Use durable storage for account
data as described in [PERSISTENCE.md](PERSISTENCE.md).

Pushing code to GitHub does not itself run the backend. Serve the frontend and
backend together on a Node.js hosting service for all three chain views to work.

## Important: GitHub Pages Limitation

GitHub Pages hosts static files only. It cannot run `backend/server.js`.

Wallet connections and trading need backend APIs at `/api/testnet/*` and
`/api/evm/*`. For GitHub Pages you must host the backend separately (for example:
Render, Railway, Fly.io or a VPS). The EVM desk currently uses same-origin
`/api/evm/*` URLs, so static Pages hosting alone is not sufficient; hosting the
whole application together is the recommended option.

## Point Frontend to Hosted Backend

Use either method:

1. In setup page, set **Testnet Backend Origin** to your backend URL.
2. Or open testnet with query override:

```text
https://<your-pages-domain>/testnet.html?apiOrigin=https://<your-backend-domain>
```

The value is saved to localStorage key `mp_testnet_api_origin`.

## Render Deployment (Backend + Frontend Together)

This repo now includes [render.yaml](render.yaml), so Render will run it as a Node web service:

- Build command: `npm ci`
- Start command: `npm run start:backend`
- Health check: `/api/testnet/health`

After deploy, open your Render URL root (`/`) for the landing page, or
`/testnet.html` for the trading desk.

The blueprint enables automatic deployment. A push to a branch connected to
your hosting service may trigger deployment. Review which branch is connected
before merging a portable-project update into it.

Important for "always on":

- Use a non-sleeping Render plan (for example Starter or higher).
- Sleeping/free instances can pause when idle, which is a Render platform behavior and cannot be overridden in app code.
