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

## Trust tiers (`../contrib/runtime-loader.ts`)

Every plugin source is classified before it is evaluated, and the tier picks
the pipeline:

| Tier | Source | Realm | Authority |
|---|---|---|---|
| `bundled` | this tree | renderer | full SDK |
| `local` | `desktop-plugins/<name>/plugin.js`, or a `plugins/<name>/desktop/` half with no catalog provenance | renderer | full SDK (error isolation only — a disk file the user placed can already run code) |
| `catalog` | a package installed from the plugin catalog (`.hermes-package.json` carries `catalogName`) | per-plugin `<iframe sandbox="allow-scripts">`, opaque origin, `default-src 'none'` CSP, its own React copy | the capability-gated subset in `../contrib/sandbox/methods.ts` |

Catalog plugins render their contributions INSIDE the frame: the host mounts a
placeholder (`SandboxSlot`) in the contribution's area and streams its rect to
the guest, one frame per plugin. Grants come from `desktop_capabilities:` in
the package's `plugin.yaml` (default `ui`, `storage`, `events`, `rest`; the
full vocabulary is `../contrib/sandbox/capabilities.ts`). A call outside the
grant is refused with a toast naming the plugin and the capability; host DOM
access is never bridged. Not carried across the bridge on day one: `ctx.socket`
(resolves to a no-op), `ctx.i18n`, `when()` predicates, the SDK's UI component
library (a plugin imports it, but only a small set of plain fallbacks render;
the rest throw a readable error when used), and host calls made from inside
`onDispose`.
