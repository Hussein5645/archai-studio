# Hosting

Where each part of ArchAI runs, and how to deploy it.

| Part | Where | Address |
|---|---|---|
| Web app | Vercel, project `archai-studio`, this repository | https://archai-studio-six.vercel.app |
| Old web address | Vercel, project `archai2-0` (the old private repository) | https://archai2-0.vercel.app, redirects every path to the address above |
| Cloud: accounts, online projects, live boards, libraries | Cloudflare Workers + D1 + R2 + Durable Objects (`workers/archai-cloud`) | https://archai-cloud.mklkoklpp.workers.dev |
| VR share service | Cloudflare Worker + R2 (`workers/vr-share`) | https://archai-vr-share.mklkoklpp.workers.dev |
| VR viewer (what a VR link opens) | Vercel, project `archai-vr`, the **private** repository `Hussein5645/SJP-VR` | https://archai-vr.vercel.app |
| Downloads (installers, APK, plugins) | Cloudflare R2 `archai-native`, `archai-revit` (public) and GitHub Releases | see the README and the download page |

## Web app (Vercel)

The web app is a static Vite build. Vercel builds it from `main` on every push, with the settings
in [`vercel.json`](../vercel.json):

- `npm ci --ignore-scripts`: skips the Electron and workerd downloads the web build does not need.
- `npm run build:web` into `dist/` (typechecking runs in CI instead, see `.github/workflows`).
- Every path that is not a file serves `index.html` (boards live at `/<name>-<id>`, invite links
  arrive as `/?invite=<token>`).
- Hashed files in `/assets/` are cached for a year; `index.html` revalidates on every load.
- Basic security headers. The Content-Security-Policy is a `<meta>` tag in `index.html`; it allows
  `https:` connections, so the cloud and the libraries work from any origin.

No environment variables are needed: the cloud and VR addresses are built in. To point a fork's
deployment elsewhere, set them in the Vercel project (Settings, Environment Variables):

| Variable | Default | What it is |
|---|---|---|
| `VITE_CLOUD_URL` | `https://archai-cloud.mklkoklpp.workers.dev` | the `archai-cloud` Worker |
| `VITE_VR_SHARE_URL` | `https://archai-vr-share.mklkoklpp.workers.dev` | the `vr-share` Worker |
| `VITE_ACCOUNT_CONTACT` | `mklkoklpp@gmail.com` | who people email for an account |

Invite pages served by the cloud link to the web app through the Worker's `WEB_APP_URL` var
(`workers/archai-cloud/wrangler.toml`): "Open in the browser" opens `<WEB_APP_URL>/?invite=<token>`.

### Moving the web app again

Point the old deployment at the new one with a redirect-only `vercel.json`, as the old private
repository does now:

```json
{
  "redirects": [{ "source": "/:path*", "destination": "https://archai-studio-six.vercel.app/:path*", "permanent": true }]
}
```

Then update `WEB_APP_URL` in `workers/archai-cloud/wrangler.toml` and redeploy the Worker.

## VR viewer (private repository)

A VR link (`https://archai-vr-share.mklkoklpp.workers.dev/v/<id>`) redirects to the **VR viewer**
with `?tour=<tour.json URL>`. The viewer is a separate WebXR app (three.js) kept in the private
repository `Hussein5645/SJP-VR`; it is **not** part of this repository and its code is not
covered by this repository's license. It is a static site deployed on Vercel (project
`archai-vr`, no build step) from that repository's `main` branch.

Which viewer VR links open is the `VIEWER_URL` var of the VR share Worker
(`workers/vr-share/wrangler.toml`). The tour format the viewer reads is documented in
[vr-tours.md](vr-tours.md), so another viewer can be used for development.

## Cloud (Cloudflare)

See [accounts-and-cloud.md](accounts-and-cloud.md): deploying the Workers, the database schema,
creating accounts, and running all of it locally with `wrangler dev`.
