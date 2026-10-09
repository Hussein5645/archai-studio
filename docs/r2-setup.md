# Cloudflare R2 connection

Bucket: `archai-assets`

Since accounts (docs/accounts-and-cloud.md) the app reads this bucket only through the
`archai-cloud` Worker (`<cloud>/lib/<token>/<key>`, signed-in users), not through a public URL;
`VITE_R2_CATALOG_URL` is no longer used. The steps below are the original public setup, kept for
uploading and for older installs until public access is switched off.

1. Enable a public development URL for local development. Use a custom domain before production.
2. Add the policy in `r2/cors.json` to the bucket's CORS Policy. Add the deployed ArchAI origin
   later; origins must be exact and must not contain a trailing slash or path.
3. Upload `r2/catalog.json` at the bucket root.
4. Set `VITE_R2_CATALOG_URL` in `.env.local` to the public bucket root, including the trailing `/`.
5. Restart Vite after changing `.env.local`.

The app fetches `catalog.json`, downloads each listed `.CAI`, validates its metadata and mapping,
and uses the mapped top view in the 2D asset library. General assets remain R2-driven. Door and
window packages appear in the dedicated System assets chooser and replace only their built-in 2D
appearance. Walls, stairs, rooms, and room dividers remain lightweight built-in tools.

The R2 S3 API URL is not used by the browser and must never be placed in `VITE_R2_CATALOG_URL`.
Use only the public `r2.dev` root for development or the production custom domain.
