/**
 * Admin REST API for the team library — declarative route table served at
 * the gateway layer via `registerRoute` (same seat as tenancy/persona,
 * design 05 §2.2):
 *
 *   /tentacle/api/admin/teams              GET list, POST create
 *   /tentacle/api/admin/teams/members      GET experts the picker may choose
 *   /tentacle/api/admin/teams/templates    GET bundled template library
 *   /tentacle/api/admin/teams/update       POST patch
 *   /tentacle/api/admin/teams/remove       POST delete (builtin → 409)
 *   /tentacle/api/admin/teams/restore      POST reset a builtin to its template
 *   /tentacle/api/admin/teams/skills       GET materialized skills (query id)
 *   /tentacle/api/admin/teams/skills/get   GET one skill (query id, path)
 *   /tentacle/api/admin/teams/skills/refresh POST re-materialize member skills
 *
 * The route is non-public, so the gateway has already authenticated the
 * caller; the handler authorizes on the `teams` permission key (added to
 * plugin-tenancy's catalog — design 05 §3: every key maps to a real
 * enforcement point). Errors are a fixed vocabulary — no stack traces, no
 * internals (design 02 §6).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GatewayRoute } from '@tentacle/gateway'
import { TeamError, type TeamInput, type TeamPatch } from './library.js'
import type { ExpertModelSelection } from '@tentacle/persona'
import type {
  TeamMemberOption,
  TeamSkillFile,
  TeamView,
  TentacleTeams,
} from './service.js'
import type { QuickPrompt, QuickPromptInput, TeamCollaboration, TeamContractInput, TeamMemberInput, TeamTemplateManifest } from './types.js'

export const TEAMS_ADMIN_PREFIX = '/tentacle/api/admin/teams'

/** The narrow service face the routes consume (satisfied by TentacleTeams). */
export interface TeamAdminApi {
  listTeams(): readonly TeamView[]
  listMemberOptions(): readonly TeamMemberOption[]
  listTemplates(): readonly TeamTemplateManifest[]
  listSkills(teamId: string): readonly TeamSkillFile[]
  getSkill(teamId: string, path: string): TeamSkillFile
  refreshTeamSkills(teamId: string): readonly string[]
  createTeam(input: TeamInput): Promise<unknown>
  createTeamFromTemplate(templateId: string, overrides?: Partial<TeamInput>): Promise<unknown>
  updateTeam(id: string, patch: TeamPatch): Promise<unknown>
  removeTeam(id: string): Promise<void>
  restoreTeamFromTemplate(id: string): Promise<unknown>
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

/** Stable public error codes — TeamError codes map 1:1, nothing else leaks. */
function errorStatus(error: unknown): { status: number; code: string } {
  if (error instanceof TeamError) {
    const status = {
      'duplicate-team': 409,
      'no-such-team': 404,
      'no-such-template': 404,
      'builtin-protected': 409,
      'invalid-team': 400,
      'team-in-use': 409,
      'member-invalid': 400,
      'members-too-few': 400,
      'members-too-many': 400,
      'invalid-collaboration': 400,
      'invalid-contract': 400,
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

/** Roster input: members are required and validated by the library. */
function membersInput(value: unknown): TeamMemberInput[] {
  if (!Array.isArray(value)) return []
  return value.map((row) => {
    const raw = (row ?? {}) as Record<string, unknown>
    return {
      expertId: String(raw.expertId ?? ''),
      role: localizedInput(raw.role),
    }
  })
}

/** Contract input: every field optional; the library applies the bounds. */
function contractInput(value: unknown): TeamContractInput | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  return {
    ...(raw.goal === undefined ? {} : { goal: localizedInput(raw.goal) }),
    ...(raw.constraints === undefined ? {} : {
      constraints: (Array.isArray(raw.constraints) ? raw.constraints : []).map(localizedInput),
    }),
    ...(raw.delivery === undefined ? {} : { delivery: localizedInput(raw.delivery) }),
    ...(raw.examples === undefined ? {} : {
      examples: (Array.isArray(raw.examples) ? raw.examples : []).map(localizedInput),
    }),
  }
}

function quickPromptsInput(value: unknown): QuickPromptInput[] {
  if (!Array.isArray(value)) return []
  return value.map((row) => {
    const raw = (row ?? {}) as Record<string, unknown>
    return {
      title: localizedInput(raw.title),
      prompt: localizedInput(raw.prompt),
    }
  })
}

function collaborationInput(value: unknown): TeamCollaboration {
  return value === 'auto' ? 'auto' : 'dispatch'
}

interface AdminAction {
  method: string
  path: string
  run(api: TeamAdminApi, body: Record<string, unknown>, url: URL): Promise<unknown>
}

const ADMIN_ACTIONS: AdminAction[] = [
  {
    method: 'GET', path: '/',
    run: async (api) => api.listTeams(),
  },
  {
    method: 'GET', path: '/members',
    run: async (api) => api.listMemberOptions(),
  },
  {
    method: 'GET', path: '/templates',
    run: async (api) => api.listTemplates(),
  },
  {
    method: 'GET', path: '/skills',
    run: async (api, _b, url) => api.listSkills(url.searchParams.get('id') ?? ''),
  },
  {
    method: 'GET', path: '/skills/get',
    run: async (api, _b, url) => api.getSkill(
      url.searchParams.get('id') ?? '',
      url.searchParams.get('path') ?? '',
    ),
  },
  {
    method: 'POST', path: '/skills/refresh',
    run: async (api, b) => ({ materialized: api.refreshTeamSkills(String(b.id ?? '')) }),
  },
  {
    method: 'POST', path: '/',
    run: async (api, b) => {
      // A template id switches to the clone path: seed members, contract and
      // routing from the bundled template instead of asking the operator to
      // retype them (design 10 §10).
      if (typeof b.templateId === 'string' && b.templateId.trim() !== '') {
        return await api.createTeamFromTemplate(b.templateId.trim(), {
          ...(b.id === undefined ? {} : { id: String(b.id) }),
          ...(b.name === undefined ? {} : { name: localizedInput(b.name) }),
          ...(b.description === undefined ? {} : { description: localizedInput(b.description) }),
        })
      }
      return await api.createTeam({
        id: b.id === undefined ? undefined : String(b.id),
        name: localizedInput(b.name),
        description: localizedInput(b.description),
        ...(b.icon === undefined ? {} : { icon: String(b.icon) }),
        ...(b.color === undefined ? {} : { color: String(b.color) }),
        members: membersInput(b.members),
        ...(b.contract === undefined ? {} : { contract: contractInput(b.contract) }),
        ...(b.collaboration === undefined ? {} : { collaboration: collaborationInput(b.collaboration) }),
        ...(b.model === undefined ? {} : { model: b.model as ExpertModelSelection }),
        ...(b.permissionPreset === undefined ? {} : { permissionPreset: String(b.permissionPreset) }),
        ...(b.welcomeMessage === undefined ? {} : { welcomeMessage: localizedInput(b.welcomeMessage) }),
        ...(b.quickPrompts === undefined ? {} : { quickPrompts: quickPromptsInput(b.quickPrompts) }),
      })
    },
  },
  {
    method: 'POST', path: '/update',
    run: async (api, b) => {
      const patch: TeamPatch = {}
      if (b.name !== undefined) patch.name = localizedInput(b.name)
      if (b.description !== undefined) patch.description = localizedInput(b.description)
      if (b.icon !== undefined) patch.icon = String(b.icon)
      if (b.color !== undefined) patch.color = String(b.color)
      if (b.members !== undefined) patch.members = membersInput(b.members)
      if (b.contract !== undefined) patch.contract = contractInput(b.contract)
      if (b.collaboration !== undefined) patch.collaboration = collaborationInput(b.collaboration)
      if (b.model !== undefined) patch.model = b.model as ExpertModelSelection | null
      if (b.permissionPreset !== undefined) patch.permissionPreset = b.permissionPreset as string | null
      if (b.welcomeMessage !== undefined) patch.welcomeMessage = b.welcomeMessage === null ? null : localizedInput(b.welcomeMessage)
      if (b.quickPrompts !== undefined) patch.quickPrompts = quickPromptsInput(b.quickPrompts)
      return api.updateTeam(String(b.id ?? ''), patch)
    },
  },
  {
    method: 'POST', path: '/restore',
    run: async (api, b) => api.restoreTeamFromTemplate(String(b.id ?? '')),
  },
  {
    method: 'POST', path: '/remove',
    run: async (api, b) => {
      await api.removeTeam(String(b.id ?? ''))
      return { ok: true }
    },
  },
]

/** Build the gateway route registration for the team library. */
export function createTeamRoutes(teams: TeamAdminApi): GatewayRoute[] {
  return [
    {
      prefix: TEAMS_ADMIN_PREFIX,
      handler: async (req, res, context) => {
        // Admin bypass, else the `teams` permission key from plugin-tenancy's
        // catalog (design 05 §3) — the same rule the tenancy console applies.
        const identity = context.identity
        const allowed = identity !== undefined && (
          identity.roles?.includes('admin') === true
          || identity.permissions?.includes('teams') === true
        )
        if (!allowed) {
          writeJson(res, 403, { error: 'permission required: teams' })
          return
        }
        const path = (req.url ?? '/').split('?', 1)[0]!.slice(TEAMS_ADMIN_PREFIX.length) || '/'
        const action = ADMIN_ACTIONS.find((a) => a.method === req.method && a.path === path)
        if (!action) {
          writeJson(res, 404, { error: 'no such admin action' })
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://tentacle.local')
          const body = req.method === 'GET' ? {} : await readJson(req)
          writeJson(res, 200, await action.run(teams, body, url))
        } catch (error) {
          const { status, code } = errorStatus(error)
          writeJson(res, status, { error: code })
        }
      },
    },
  ]
}

/** The service satisfies the admin API structurally (kept for tests). */
export type TeamAdminService = TentacleTeams & TeamAdminApi
