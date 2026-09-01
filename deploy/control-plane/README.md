# PageSpatial control plane

This is the public control-plane deployment. The repository root `Dockerfile`
is a different artifact: the qualified Modal parse-worker image.

The deployment has three containers:

- `api`: HTTP API, dashboard, dispatcher, reconciler, and migrations;
- `postgres`: an isolated PostgreSQL 18 database with its own named volume;
- `tunnel`: an outbound-only, remotely managed Cloudflare Tunnel connector.

No host port is published. Configure both public hostnames in the remote Tunnel
to use the private Compose origin `http://api:8580`. Protect only the dashboard
hostname with Cloudflare Access; API clients authenticate with PageSpatial API
keys.

For the public alpha, configure the Access application to allow identities
verified by One-time PIN, then set `PAGESPATIAL_ALLOW_SELF_SIGNUP=1`. The origin
creates an active user only after it validates the Access JWT and grants the
configured `PAGESPATIAL_TRIAL_PAGE_CREDITS` once. The default is 100 pages.
There is no payment path in the alpha.

Grant more pages for a pending request with:

```sh
docker compose -f deploy/control-plane/compose.yaml exec api \
  npm run grant-credits -- user@example.com 100 "alpha top-up"
```

The command consumes the account's pending request. It refuses accounts with
no pending request, so retrying an already-completed top-up cannot add pages
twice.

## Start

```sh
cp deploy/control-plane/.env.example deploy/control-plane/.env
chmod 600 deploy/control-plane/.env
# Set POSTGRES_PASSWORD and use the same URL-encoded value in DATABASE_URL.
docker compose -f deploy/control-plane/compose.yaml build api
docker compose -f deploy/control-plane/compose.yaml up -d
docker compose -f deploy/control-plane/compose.yaml ps
```

The API applies committed Postgres migrations before it starts listening. A
migration or configuration error fails startup; it does not serve a partial
deployment.

PostgreSQL is not published to the host and is not shared with another Compose
project. PostgreSQL 18 stores data below `/var/lib/postgresql`; the named volume
must remain mounted at that parent path. Do not call the deployment publicly
ready until an off-site database backup has been restored successfully.

`cloudflared:latest` follows Cloudflare's documented Docker update model. Pull
and restart it deliberately during maintenance:

```sh
docker compose -f deploy/control-plane/compose.yaml pull tunnel
docker compose -f deploy/control-plane/compose.yaml up -d tunnel
```

The tunnel token is a secret that can start a connector. Store it only in the
untracked deployment `.env` or a host secret manager.

The API calls Modal from inside the container. Give this deployment a distinct
Modal token through `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`; do not copy a
developer profile into the image.

## Browser-upload CORS

Browser uploads require the exact input-bucket CORS policy in
`r2-input-cors.json`. Apply it to the input bucket only:

```sh
wrangler r2 bucket cors set "$R2_INPUT_BUCKET" \
  --file deploy/control-plane/r2-input-cors.json
```

The policy permits `PUT` from `https://app.pagespatial.dev` with only the
`Content-Type` request header. It does not make the bucket or its objects
public; the presigned URL remains the upload authorization.
