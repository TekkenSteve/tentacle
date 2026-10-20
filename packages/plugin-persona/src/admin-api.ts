/**
 * Admin REST API for the expert library — declarative route table served at
 * the gateway layer via `registerRoute` (same seat as tenancy's admin API,
 * design 05 §2.2):
 *
 *   /tentacle/api/admin/experts           GET list, POST create
 *   /tentacle/api/admin/experts/presets   GET selectable preset roster
 *   /tentacle/api/admin/experts/skills    GET list (query id)
 *   /tentacle/api/admin/experts/skills/get  GET one skill (query id, name)
 *   /tentacle/api/admin/experts/skills/save POST create/replace
 *   /tentacle/api/admin/experts/skills/remove POST delete
 *   /tentacle/api/admin/experts/update    POST patch (builtin: routing/preset)
 *   /tentacle/api/admin/experts/remove    POST delete (builtin → 409)
 *
 * The route is non-public, so the gateway has already authenticated the
 * caller; the handler authorizes on `roles` only. Errors are a fixed
 * vocabulary — no stack traces, no internals (design 02 §6).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GatewayRoute } from '@tentacle/gateway'
import { ExpertError, type ExpertInput, type ExpertPatch } from './experts.js'
import type { CreateFromTemplateInput, ExpertTemplateView, PresetRosterView, SkillFile } from './service.js'
import type { Expert, ExpertModelSelection, ExpertSkillSummary } from './types.js'

export const EXPERTS_ADMIN_PREFIX = '/tentacle/api/admin/experts'

/** The narrow service face the routes consume (satisfied by TentaclePersona). */
export interface ExpertAdminApi {
  listExperts(): readonly Expert[]
  /** Deployment default expert (the one pre-expert channels migrate onto). */
  readonly defaultExpertId: string
  setDefaultExpert(id: string): Promise<Expert>
  /** Absolute workspace path of one instance (shown in the detail drawer). */
  workspaceOf(expertId: string): string
  /** Bundled templates, with the instance each one planted. */
  listTemplates(): readonly ExpertTemplateView[]
  /** Selectable presets (official + template presets + owned presets). */
  listPresets(): Promise<readonly PresetRosterView[]>
  listSkills(expertId: string): readonly ExpertSkillSummary[]
  getSkill(expertId: string, name: string): SkillFile
  saveSkill(expertId: string, input: { name: string; description: string; body: string }): SkillFile
  removeSkill(expertId: string, name: string): void
  createExpert(input: ExpertInput): Promise<Expert>
  /** Clone a bundled template into a new instance (seed files + provenance). */
  createExpertFromTemplate(templateId: string, overrides?: CreateFromTemplateInput): Promise<Expert>
  updateExpert(id: string, patch: ExpertPatch): Promise<Expert>
  removeExpert(id: string): Promise<void>
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) as Record<string, unknown> : {}
}

/** Stable public error codes — ExpertError codes map 1:1, nothing else leaks. */
function errorStatus(error: unknown): { status: number; code: string } {
  if (error instanceof ExpertError) {
    const status = {
      'duplicate-expert': 409,
      'no-such-expert': 404,
      'builtin-protected': 409,
      'invalid-expert': 400,
      'expert-in-use': 409,
      'no-such-template': 404,
      'no-such-preset': 404,
      'invalid-skill': 400,
    }[error.code] as number
    return { status, code: error.code }
  }
  return { status: 400, code: 'bad-request' }
}

/** A localized field arrives either as a plain string or a { zh, en } pair. */
function localizedInput(value: unknown): string | { zh: string; en: string } {
  if (typeof value === 'object' && value !== null) {
    const raw = value as Record<string, unknown>
    return { zh: String(raw.zh ?? ''), en: String(raw.en ?? '') }
  }
  return String(value ?? '')
}

interface AdminAction {
  method: string
  path: string
  run(persona: ExpertAdminApi, body: Record<string, unknown>, url: URL): Promise<unknown>
}

const ADMIN_ACTIONS: AdminAction[] = [
  {
    method: 'GET', path: '/',
    // Project the selected preset / default flag / workspace path and skill
    // count the console renders; the stored record stays the source of truth.
    run: async (p) => p.listExperts().map((expert) => ({
      ...expert,
      default: expert.id === p.defaultExpertId,
      workspacePath: p.workspaceOf(expert.id),
      skills: p.listSkills(expert.id).length,
    })),
  },
  {
    method: 'GET', path: '/presets',
    run: async (p) => p.listPresets(),
  },
  {
    method: 'GET', path: '/skills',
    run: async (p, _b, url) => p.listSkills(url.searchParams.get('id') ?? ''),
  },
  {
    method: 'GET', path: '/skills/get',
    run: async (p, _b, url) => p.getSkill(
      url.searchParams.get('id') ?? '',
      url.searchParams.get('name') ?? '',
    ),
  },
  {
    method: 'POST', path: '/skills/save',
    run: async (p, b) => p.saveSkill(String(b.id ?? ''), {
      name: String(b.name ?? ''),
      description: String(b.description ?? ''),
      body: String(b.body ?? ''),
    }),
  },
  {
    method: 'POST', path: '/skills/remove',
    run: async (p, b) => {
      p.removeSkill(String(b.id ?? ''), String(b.name ?? ''))
      return { ok: true }
    },
  },
  {
    method: 'GET', path: '/templates',
    run: async (p) => p.listTemplates(),
  },
  {
    method: 'POST', path: '/',
    run: async (p, b) => {
      // A template id switches to the clone path: seed the persona/files from
      // the bundled template instead of asking the operator to retype them.
      if (typeof b.templateId === 'string' && b.templateId.trim() !== '') {
        return await p.createExpertFromTemplate(b.templateId.trim(), {
          ...(b.id === undefined ? {} : { id: String(b.id) }),
          ...(b.name === undefined ? {} : { name: localizedInput(b.name) }),
          ...(b.description === undefined ? {} : { description: localizedInput(b.description) }),
        })
      }
      return await p.createExpert({
        id: b.id === undefined ? undefined : String(b.id),
        name: localizedInput(b.name),
        description: localizedInput(b.description),
        icon: b.icon === undefined ? undefined : String(b.icon),
        agentPreset: String(b.agentPreset ?? ''),
        ...(b.model === undefined ? {} : { model: b.model as ExpertModelSelection }),
        ...(b.permissionPreset === undefined ? {} : { permissionPreset: String(b.permissionPreset) }),
      })
    },
  },
  {
    method: 'POST', path: '/update',
    run: async (p, b) => {
      const patch: ExpertPatch = {}
      if (b.name !== undefined) patch.name = localizedInput(b.name)
      if (b.description !== undefined) patch.description = localizedInput(b.description)
      if (b.icon !== undefined) patch.icon = String(b.icon)
      if (b.agentPreset !== undefined) patch.agentPreset = String(b.agentPreset)
      if (b.model !== undefined) patch.model = b.model as ExpertModelSelection | null
      if (b.permissionPreset !== undefined) patch.permissionPreset = b.permissionPreset as string | null
      return p.updateExpert(String(b.id ?? ''), patch)
    },
  },
  {
    method: 'POST', path: '/default',
    run: async (p, b) => p.setDefaultExpert(String(b.id ?? '')),
  },
  {
    method: 'POST', path: '/remove',
    run: async (p, b) => {
      await p.removeExpert(String(b.id ?? ''))
      return { ok: true }
    },
  },
]

/** Build the gateway route registration for the expert library. */
export function createExpertRoutes(persona: ExpertAdminApi): GatewayRoute[] {
  return [
    {
      prefix: EXPERTS_ADMIN_PREFIX,
      handler: async (req, res, context) => {
        // Admin bypass, else the `experts` permission key from plugin-tenancy's
        // catalog (design 05 §3) — the same rule the tenancy console applies.
        const identity = context.identity
        const allowed = identity !== undefined && (
          identity.roles?.includes('admin') === true
          || identity.permissions?.includes('experts') === true
        )
        if (!allowed) {
          writeJson(res, 403, { error: 'permission required: experts' })
          return
        }
        const path = (req.url ?? '/').split('?', 1)[0]!.slice(EXPERTS_ADMIN_PREFIX.length) || '/'
        const action = ADMIN_ACTIONS.find((a) => a.method === req.method && a.path === path)
        if (!action) {
          writeJson(res, 404, { error: 'no such admin action' })
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://tentacle.local')
          const body = req.method === 'GET' ? {} : await readJson(req)
          writeJson(res, 200, await action.run(persona, body, url))
        } catch (error) {
          const { status, code } = errorStatus(error)
          writeJson(res, status, { error: code })
        }
      },
    },
  ]
}
