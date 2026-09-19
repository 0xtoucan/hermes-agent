# Bundled plugins

Drop a `<name>/plugin.{ts,tsx}` here that default-exports a `HermesPlugin` and
it registers automatically at boot (vite glob in `../contrib/plugins.ts`), with
the same inventory + live enable/disable contract as runtime plugins.

Keep this tree for real shipped plugins (and the small authoring fixtures that
dogfood the SDK). One-off demos that rebuild a core chrome piece 1:1 do not
belong here — they double the UI and confuse Capabilities ▸ Plugins. Publish those
in the companion
[`hermes-example-plugins`](https://github.com/NousResearch/hermes-example-plugins)
repo instead.

User- and agent-authored plugins load at runtime from
`$HERMES_HOME/desktop-plugins/<name>/plugin.js` (the disk door) — see the
`hermes-desktop-plugins` skill.

## Trust tiers and the sandbox (`../contrib/runtime-loader.ts`, `../contrib/sandbox/`)

Every plugin source is classified (`pluginTrust`) before it is evaluated, and
the tier picks the pipeline:

| Tier | Source | Realm | Authority |
|---|---|---|---|
| `bundled` | this tree | renderer | full SDK |
| `local` | `desktop-plugins/<name>/plugin.js`, or a `plugins/<name>/desktop/` half whose package folder was copied in by hand (no catalog sidecar, no git remote) | renderer | full SDK (error isolation only — a disk file the user placed can already run code) |
| `remote` | the desktop half of any INSTALLED package — plugin catalog, `hermes plugins install <git-url>`, the agent-callable `plugins.install` RPC; its `.hermes-package.json` carries `catalogName`, `repo`, or `sidecarUnreadable` | per-plugin `<iframe sandbox="allow-scripts">`, opaque origin, `default-src 'none'` CSP, its own React copy | the capability-gated subset in `../contrib/sandbox/methods.ts` |

The rule is "not hand-copied ⇒ sandboxed". A marker file that exists but
cannot be parsed refuses the load (error row + toast) instead of falling back
to `local`.

### What the sandbox blocks

Remote-tier plugins render their contributions INSIDE the frame: the host mounts a
placeholder (`SandboxSlot`) in the contribution's area and streams its rect to
the guest, one frame per plugin. The frame has an opaque origin and a
`default-src 'none'` CSP, so the guest has no network, no host DOM, no host
storage or cookies, and no gateway socket of its own — every effect goes through
the postMessage bridge, and the bridge answers only the rows in
`../contrib/sandbox/methods.ts`. Each row names the ONE capability it needs.
`ctx.rest` keeps the SDK's contract (the plugin's own `/api/plugins/<id>/`
namespace); reaching any other `/api/` route is the sandbox-only `ctx.restAny`,
behind `rest:any`. `host.request` is an exact-name allowlist
(`GATEWAY_METHOD_CAPABILITIES` in `capabilities.ts`); `cli.exec`,
`profiles.configure`, filesystem, terminal and secrets RPCs stay host-only by
design. `ctx.os.openExternal` admits http(s) only and `ctx.os.revealPath` only
paths inside the plugin's own install folder. Host DOM access
(`host.querySelector` & co.) throws with a hint to use `host.composer`.

Not carried across the bridge, by design (see `guest-runtime.js`): statusbar
`menuContent` (dropped with a console warning — use `render` with an SDK
`Popover`), `icon` given as a component on palette/nav items (the host draws its
own glyph), `when()` predicates (the contribution is always shown), host calls
made from inside `onDispose`. `useI18n` in the frame sees only a catalog slice
(`BRIDGED_CATALOG_PATHS` in `loader.ts`) plus the plugin's own bundles;
`Streamdown` is bundled into the frame only when the plugin imports it.

### Capabilities: defaults vs requests

The vocabulary is `../contrib/sandbox/capabilities.ts`, declared as a
`desktop_capabilities:` list in the package's `plugin.yaml`. Every plugin gets
the four defaults — `ui`, `storage`, `events`, `rest` — whether or not it lists
them. Everything else is a REQUEST, not a grant: `rest:any`, `gateway:request`,
`prompt:submit`, `llm`, `composer`, `navigate`, `os:clipboard`, `os:dialogs`,
`os:open-external`, `os:reveal-path`, `os:notify`. Unknown names are dropped and
reported, never widened.

### Consent (`../contrib/sandbox/grants.ts`)

A plugin runs with the defaults until the user clicks **Allow** on its row in
Capabilities ▸ Plugins, where the requests show as plain-language chips under
**Permissions** (labels: `capability-labels.ts` → `skills.plugins.capabilityLabels`
in the i18n catalogs). Grants are persisted per plugin id (its install folder)
per profile in renderer localStorage
(`hermes.desktop.pluginCapabilityGrants.v1.profile.<profile>`), follow a profile
rename and die with a profile delete, and are revocable from the same row
(**Revoke**). Allow/Revoke apply live to the next bridge call. On first
activation with pending requests the user gets one non-hijacking toast
("<name> asks for permissions", with a **Review** action that navigates to the
row). A refused call toasts `Plugin "<name>" blocked` with a Review action when
the capability was requested but not allowed, or tells the author to declare
it under `desktop_capabilities` when it was never declared.
