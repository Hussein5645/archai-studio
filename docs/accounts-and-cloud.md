# Accounts, cloud projects and shared boards

Status: **phase 1 and 2 implemented** (2026-10-10): accounts, online projects, account-gated
libraries, VR links, plugin sign-in, invites and roles, and editing together with live cursors.
Both are deployed (phase 2 on 2026-10-10: the `invites` table and the `Board` Durable Object).

## Goal

- **No account needed.** ArchAI works on this device as before: local projects, .AIR files,
  autosave, plugins, live link. Nothing asks you to sign in.
- **With an account** you get the cloud: online projects, the asset / material / render
  libraries, VR tour links (also from the plugins), invites, and several people editing the
  same board at once with everyone's cursor visible (like Miro).

| Feature | Without account | With account |
|---|---|---|
| Local projects, files, export, plugins, live link | yes | yes |
| Online projects | no | yes |
| Asset, material and render libraries | no (built-in tools and own imports only) | yes |
| VR tour links (app and plugins' Open in VR) | no | yes, listed under the account |
| Invites, editing together, live cursors | no | yes |

## What runs on Cloudflare

| Piece | Cloudflare | Holds |
|---|---|---|
| `archai-cloud` Worker (`workers/archai-cloud`) | Workers | the API: accounts, projects, libraries |
| `archai` database (`schema.sql`) | D1 | users, sessions, projects, members, invites, vr_tours |
| `archai-projects` bucket | R2 | online projects (`projects/<id>.json`, self-contained documents) |
| `archai-assets` bucket | R2 | the libraries, served by `archai-cloud` at `/lib/<token>/<key>` |
| `archai-vr-share` Worker (`workers/vr-share`) | Workers + R2 | VR tours; uploads need an account session (it reads the same D1) |
| `Board` Durable Object (`src/board.js`), one per online project | Durable Objects (SQLite) | the live document, recent edits, everyone's connection |

Live at `https://archai-cloud.mklkoklpp.workers.dev` (`VITE_CLOUD_URL` overrides). Deploy and
database commands are at the top of `workers/archai-cloud/wrangler.toml`. The library links are
signed with the `LIBRARY_SECRET` Worker secret.

## Accounts

- **By invitation.** Nobody can sign up: `POST /auth/signup` answers "accounts are by invitation
  for now: email <CONTACT_EMAIL>" (the `CONTACT_EMAIL` var in `wrangler.toml`). People ask the
  owner by email (the sign-in dialog has an "Ask for one" mail link, `ACCOUNT_CONTACT` in
  `src/cloud/account.ts`), and the owner creates the account with the admin script, which talks to
  D1 through the owner's own `wrangler login` (no admin key exists to leak):

  ```bash
  cd workers/archai-cloud
  node admin.mjs add person@example.com "Their Name"   # prints a generated password to send them
  node admin.mjs reset person@example.com              # new password, signs them out everywhere
  node admin.mjs list
  node admin.mjs remove person@example.com             # deletes the account and projects it owns
  ```

  Add `--local` for the `wrangler dev` database. Local development can open sign-up again with
  `ALLOW_SIGNUP=1` in `.dev.vars`, and development builds of the app then show "Create an account".
- Email + password; passwords are hashed with PBKDF2 (100k rounds) in the Worker. Users change
  their password in the account menu (**Change password**, `POST /auth/password`); a forgotten
  password is reset by the owner (`admin.mjs reset`).
- Sessions last 90 days and renew while used. The token sits in host storage (`account`), so the
  board, ArchAI Render and the plugins share one sign-in; only its SHA-256 is stored server-side.
- Signing out never touches projects on this device.
- Code: `src/cloud/account.ts` (session, calls), `src/ui/AccountDialog.tsx`,
  `src/ui/AccountButton.tsx` (account menu, upload state), `workers/archai-cloud/admin.mjs`.

## Online projects

Home has **Recent Projects** (this device; online ones are tagged *Online*), **Online Projects**
(from the server: yours and the ones shared with you) and **Join with a link**.

- **Put online** (cloud button on a project card, the account menu, or **Share** in a project)
  uploads a copy of the project as a new online project and opens it; the local project stays.
- **Save a copy on this device** (online card, or the account menu) makes a normal local project.
- The owner can delete an online project; others can leave it (Share dialog).
- Code: `src/cloud/projects.ts`; the session entry of an online project carries
  `cloud: { version, role, pending }` (`src/persistence/session.ts`).

## Editing together

Every read and write of an online project goes through its **Board**, a Durable Object per
project (`workers/archai-cloud/src/board.js`); the app connects to it with a WebSocket
(`GET /projects/<id>/live`, the session token as the `auth.<token>` subprotocol) while the project
is open (`src/cloud/live.ts`).

1. ArchAI edits are already small changes: every command, undo and redo produces immer patches
   (`CommandExecutor.onDocChange`). Each is sent as a batch at once; edits over 400 KB (images,
   imported models) go over HTTP (`POST /projects/<id>/ops`) and are announced to the others,
   who read them with `GET /projects/<id>/ops?since=<version>`.
2. The Board applies batches in arrival order, numbers them (`version`) and forwards them to the
   others. A batch that no longer fits (what it edits was deleted meanwhile) or would leave a
   broken reference (an element in a deleted group, a copy of a deleted definition) is refused.
3. Each client keeps the Board's version of the document plus its own batches not yet
   acknowledged, and applies others' batches under its own, so everyone ends up with the Board's
   document: last edit wins per property, edits to different properties both stay. A refused
   batch is undone locally with a short notice.
4. Undo and redo only undo your own steps; a step someone else's edit made impossible is dropped.
5. Every acknowledged batch is in the Board's storage before the ack; the whole document goes to
   R2 20 s after activity, when the last person leaves, and at once for very large batches. A
   restarted Board replays the stored batches after the R2 copy, so nothing acknowledged is lost.
6. Reconnecting: the app says which version it has (`hello`); the Board sends what is missing, or
   tells it to reload; batches sent twice are recognised and applied once. Edits made with no
   connection stay pending, are sent when it is back, and survive closing the app (`pending`):
   the next open uploads them, or keeps them as "(offline changes)" if the project moved on.
7. Top bar: *Online · saved*, *Saving online...*, *Connecting...*, *Offline · edits kept on this
   device*, or *View only*.
8. WebSockets hibernate when idle, so an open board nobody touches costs nothing.

### Live cursors and selections

Like a Miro board: everyone's pointer is drawn with their name in their colour, gliding smoothly
between updates (eased in board coordinates, so it stays put while you pan or zoom), and what they
have selected gets a dashed outline in their colour. Pointers are sent at most every 40 ms. The
top bar shows an avatar per person on the board. Code: `src/render/PeersOverlay.tsx`,
`src/ui/PeersBar.tsx`.

## Invites and roles

- Roles: **owner** (shares, deletes), **editor**, **viewer** (sees everything live, cannot edit:
  the executor refuses document changes, `setReadOnly`).
- **Share** (top bar, or the people button on an online card) opens the Share dialog
  (`src/ui/ShareDialog.tsx`):
  - **Add people**: by the email of an existing account; the project appears in their Online
    Projects at once. (There is no email sending yet, so unknown emails get an invite link.)
  - **Invite link**: role and expiry (never, 7 or 30 days); listed with its uses, withdrawable.
  - **People with access**: the owner changes roles or removes people, which applies to their
    open board at once (a removed person keeps the project open, view only); others can leave.
- An invite link (`<cloud>/invite/<token>`) opens a page with **Open in ArchAI**
  (`archai://invite/<token>`: the desktop app opens the Join dialog; Electron passes the link from
  the command line, `IPC.linkEvent` / `IPC.linkTake`), and **Open in the browser** when
  `WEB_APP_URL` is set on the Worker (`?invite=<token>` in the web app). Home → **Join with a
  link** accepts the pasted link too (`src/ui/JoinDialog.tsx`).

## Libraries

The asset catalog, material library and render library come from `archai-assets` through
`archai-cloud`: `<cloud>/lib/<library token>/<key>`. The token is an HMAC of the user id valid for
30 days and renewed at every start, so it also works in `<img>`. Documents never keep it: catalog
URLs saved in a document use `/lib/-/<key>` (`storedLibraryUrl`) and get the current token when
fetched (`libraryUrl`, which also maps the old public `r2.dev` URLs of older documents). Signed out,
the panels show a sign-in prompt; imported and local packages keep working. Code:
`src/cloud/library.ts`.

## VR links

`publish-vr-tour` uploads with the session token (`Authorization: Bearer`); signed out it asks to
sign in. The VR Worker records tours in `vr_tours` and only lets an account republish its own.

## Plugins

A plugin's **Open in VR** asks the running ArchAI desktop app for the account over the live link:
`GET /live/account?app=<App>&prompt=1` → `{ signedIn, token, user }` (`electron/liveLink.ts`,
answered by `src/live/board.ts`). Nobody signed in: ArchAI comes to the front with its sign-in
dialog and the plugin says to sign in and run Open in VR again. ArchAI not running: the plugin
starts it. Implemented in the three plugin cores (`VrShare.Config` in C#, `share_config` in
Python, `Core.share_config` in Ruby); no key is built into the plugins any more.

## Public access switched off (2026-10-10)

With the public source release (0.2.2.13) the cloud is reachable only with an account:

- The `archai-assets` bucket's public `r2.dev` URL is disabled; libraries come only through
  `archai-cloud` (`/lib/<token>/...`). Versions up to 0.2.2.11 no longer get the libraries.
- The VR share Worker's `UPLOAD_KEY` secret is deleted: publishing VR tours needs an account
  session. Plugins before 0.4.0 can no longer publish.
- Still public on purpose: the downloads bucket (`archai-native`, `archai-revit`) and published VR
  tours (`/v/<id>` links are meant to be shared).

Deploying changes: `schema.sql` is idempotent (re-run it with `--remote` after adding tables),
then `npx wrangler deploy` in `workers/archai-cloud`.

## Testing locally

`.claude/launch.json` has `archai-cloud-local` (`wrangler dev --local` on 8787, with
`.dev.vars` holding a local `LIBRARY_SECRET` and a local test account) and
`archai-web-local-cloud` (Vite on 5175 with `VITE_CLOUD_URL=/__cloud`, proxied to 8787, WebSockets
included, by `vite.config.ts` when `ARCHAI_LOCAL_CLOUD` is set); `archai-web-local-cloud-2` is the
same on 5176, a second origin (its own sign-in) for a second person. Create the local tables
first: `npx wrangler d1 execute archai --local --file schema.sql`.

## Decisions (2026-10-09)

1. Sign-in: email + password only.
2. Libraries need an account.
3. Address: `archai-cloud.mklkoklpp.workers.dev` for now; a custom domain can come later.
4. Plugins sign in too, through the ArchAI desktop app (2026-10-10).
5. Live cursors like a Miro board (2026-10-10).
6. Public repository github.com/Hussein5645/archai-studio; accounts by invitation, created by the owner (2026-10-10).
   Source-available under PolyForm Strict 1.0.0 plus a contribute-by-pull-request permission
   (2026-10-10; v0.2.2.13 and earlier were AGPL-3.0).
