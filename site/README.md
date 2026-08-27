# Public site

This directory is the static public site for `pagespatial.dev`. It is separate
from the Access-protected dashboard at `app.pagespatial.dev` and the API at
`api.pagespatial.dev`.

The visual system is implemented directly from `/tmp/pagespatial_v3.zip`:
Ivory Ledger paper, ink hero, orange actions, the supplied PageSpatial logo,
and the supplied Instrument Sans, Newsreader, and IBM Plex Mono typography.
Marketing claims were checked against committed PageSpatial evidence before
publication.

There is intentionally no public waitlist form yet. Pilot invitations are
owner-provisioned; the static site must not imply that it stores requests or
publish a personal email address as a temporary substitute.

Preview locally:

```bash
npx wrangler pages dev site
```

Deploy after creating the `pagespatial-site` Pages project:

```bash
npx wrangler pages deploy site --project-name pagespatial-site --branch main
```

Cloudflare Pages must associate the apex custom domain `pagespatial.dev` with
the project. Adding only a DNS CNAME without that association is not enough.
