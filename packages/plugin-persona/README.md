# @tentacle/persona

English | [中文](README.zh.md)

Expert library for DSH — the Tentacle bundle's persona/expert layer (design: [docs/mapping.md §3](../../docs/mapping.md), [04-architecture.md](../../docs/design/04-architecture.md)).

Two levels (design 09): **templates** are bundled directories (`templates/<id>/manifest.json` + seed files) and **experts** are user-owned instances created from a template (or blank). Creating an instance copies the seed files into its workspace and snapshots the manifest; template upgrades never touch existing instances (detach rule).

An expert is the **composition root**, not a preset: it **selects** one registered Agent preset as its capability layer (tools, skill providers, MCP, team, base persona), and owns identity, workspace (where `.dsh/skills` live), model route, permission preset and channel bindings. Any number of experts may select the same preset; the expert never derives or registers one. Channels resolve the instance through `resolveForSession()` and start sessions with the selected preset id, the model and the shared workspace (`agents/<id>/workspace`).

- **ExpertLibrary**: pure, cordis-free domain core — `{ id, name, description, icon?, agentPreset, builtin }` rows with CRUD. Test against `MemoryRepo`, persist with `JsonFileRepo` (atomic writes, 0600; default state root `$DSH_HOME/tentacle/persona`).
- **Builtin seeds**: four starter experts (general-assistant / ops-engineer / code-reviewer / translator) with bilingual names, descriptions and seed skills; each selects the template's `agent_preset` (default `standard`). Seeding happens exactly once per state root — afterwards the library belongs to the user and upgrades never overwrite edits.
- **Builtin protection**: builtin experts cannot be deleted (409); identity fields stay fixed, while preset selection and routing stay editable.
- **Admin API**: `/tentacle/api/admin/experts` (GET list, POST create, POST `/update`, POST `/default`, POST `/remove`, GET `/presets`, GET/POST `/skills…`), served through the gateway's `registerRoute` seat with the admin-role check. The gateway is optional: without it the library still works, only the REST surface stays unregistered.
- **Experts panel**: an admin-only GLOBAL panel (`main` + `sidebar.pannellist`, next to Channels) — fixed-height card grid in the Agency Agents style (44px avatar, template/preset pills, three-line description, model/permission/skill/channel facts, full-width action bar), "my experts / template library" tabs, a tabbed detail drawer (overview / workspace skills / bound channels / selected preset with inline composition), create / edit (Agent-preset picker; model and permission selectors read the official `session/modelCatalog` and `permissionPresets/catalog`) / template copy / delete (409 while channels route to it), a card/table toggle (persisted), and "manage channels / new channel" hops that switch to the channels panel scoped to that expert. Bilingual (zh/en).

## Usage

Zero config by default. The bundle inserts it for you; standalone:

```yaml
- id: tentacle-persona
  name: '@tentacle/persona'
```

## Boundary with the official preset UI

The official `dsh-client-ui-agent-preset` Settings section already owns the **read** side of presets: listing every registered preset (including the ones this package mounts), choosing the default for new tasks, viewing a preset's composition, and switching a preset inside a session. This package deliberately does **not** re-implement any of that — a second roster, a default picker or a composition viewer here would be duplicated surface that drifts from the official one.

What it owns is the **write** side the official UI does not have: expert CRUD (each expert is mounted as an official preset carrying a `dsh-persona` prefix), bilingual names/descriptions, the builtin seed library, and the visibility a multi-tenant gate will need (**pending**: `Expert` has no tenant/owner yet — design 09 §6-C). When in doubt, extend the write path and let the official roster render it.

## Routing values and deletion protection (design 09)

- `defaultExpertId`: `general-assistant` (else the first builtin / first instance). Channels migrate pre-expert rows onto it.
- `resolveForSession(expertId)`: the preset/model/permission/workspace source for channel sessions; an unknown id returns `undefined`, which channels treats as a dispatch failure.
- `registerExpertRemovalGuard(guard)`: plugins that store `expertId` references (channels) register a deletion veto; a referenced expert is refused with 409 `expert-in-use` rather than cascade-deleted.

## License

MIT
