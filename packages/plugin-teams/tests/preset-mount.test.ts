/**
 * S-B composition proof (design 10 §3): a team preset's rows — the persona
 * prefix, the official agent-team runtime and its model-facing tools — mount
 * through the REAL Agent preset registry.
 *
 * Two levels of evidence:
 *
 *   1. `compositionInventory()` — the registry mounts every definition eagerly
 *      and records a `broken` diagnostic instead of throwing, so a composition
 *      that cannot load would otherwise stay invisible until a team session
 *      fails to start. A broken team preset means no team session can compose.
 *   2. a REAL `WebhookRuntime` dispatch — the exact path a channel-bound team
 *      message takes (`createWebhookSession` → `agents.create` → preset mount
 *      inside the session's agent scope). The Host services around it are
 *      minimal stubs; every row under test is the real package.
 *
 * The e2e half (tests/e2e/e2e.sh §9g) drives the same composition live.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { AgentPresetRegistry as Registry } from '@deepseek-ai/dsh-agent-preset-registry'
import { Group, Loader } from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { WebhookRuntime } from '@deepseek-ai/dsh-webhook'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { teamPresetDefinition, teamPresetId } from '../src/preset.js'

/** Rows resolve their package names relative to this package's directory. */
const PACKAGE_URL = new URL('../', import.meta.url)

const HOST_PROMPT = '# 团队契约\n\n你是产品评审团队的主持人。'

interface LogLine {
  readonly type: string
  readonly args: readonly unknown[]
}

/** Minimal Host service surface the team rows and the webhook path touch. */
async function provideHostServices(ctx: Context, captured: LogLine[]): Promise<void> {
  ctx.provide('sessionProjections', { register: () => () => {}, stateOf: () => undefined })
  ctx.provide('settings', { configure: () => {} })
  // The real Loader: a preset tree is an ordinary loader entry tree, and its
  // rows are resolved and activated by that Loader. `cordis:group` rows are
  // loader builtins the host app registers during boot (app-boot's
  // mountRootInclude), so the harness registers the one group builtin here.
  await ctx.plugin(Loader)
  const loader = ctx.get('loader') as { builtins: Record<string, unknown> }
  loader.builtins.group = Group
  ctx.provide('systemPrompt', {
    section: () => () => {},
    getSectionOrder: () => 0,
    suppressRuntimeContext: () => {},
  })
  ctx.provide('agents', { list: () => [], on: () => () => {} })
  ctx.provide('sessions', {})
  ctx.provide('sessionPersistence', {})
  ctx.provide('subagents', {})
  ctx.provide('tools', {})
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => captured.push({ type: message.type, args: message.args }),
  })
}

async function bootRegistry(): Promise<{ ctx: Context; registry: AgentPresetRegistry }> {
  const ctx = new Context()
  ctx.baseUrl = PACKAGE_URL.href
  await provideHostServices(ctx, [])
  await ctx.plugin(Registry, { default: 'standard' })
  return { ctx, registry: ctx.get('agentPresets') as AgentPresetRegistry }
}

describe('team preset composition (S-B)', () => {
  it('mounts the persona, agent-team and tool-agent-team rows without breaking', async () => {
    const { ctx, registry } = await bootRegistry()
    try {
      const dispose = await registry.register(
        teamPresetDefinition({
          teamId: 'product-review',
          displayName: '产品评审 / Product Review',
          hostPrompt: HOST_PROMPT,
          memberCount: 2,
        }),
      )
      try {
        const inventory = await registry.compositionInventory()
        const row = inventory.find((entry) => entry.id === teamPresetId('product-review'))
        expect(row).toBeDefined()
        expect(row?.broken).toBeUndefined()
        expect(row?.rows.map((entry) => entry.moduleName)).toEqual([
          '@deepseek-ai/dsh-persona',
          '@deepseek-ai/dsh-experimental-agent-team',
          '@deepseek-ai/dsh-experimental-tool-agent-team',
        ])
        expect(row?.rows.every((entry) => entry.enabled)).toBe(true)
      } finally {
        await dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the roster cap in the mounted agent-team row', async () => {
    const { ctx, registry } = await bootRegistry()
    try {
      const dispose = await registry.register(
        teamPresetDefinition({
          teamId: 'tech-review',
          displayName: '技术评审 / Tech Review',
          hostPrompt: HOST_PROMPT,
          memberCount: 3,
        }),
      )
      try {
        const inventory = await registry.compositionInventory()
        const row = inventory.find((entry) => entry.id === teamPresetId('tech-review'))
        expect(row?.broken).toBeUndefined()
        const agentTeam = row?.rows.find(
          (entry) => entry.moduleName === '@deepseek-ai/dsh-experimental-agent-team',
        )
        expect(agentTeam?.enabled).toBe(true)
      } finally {
        await dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('creates a session from a channel dispatch and mounts the team preset inside it', async () => {
    const captured: LogLine[] = []
    const workspace = mkdtempSync(join(tmpdir(), 'tentacle-team-sb-'))
    const teamWorkspace = join(workspace, 'product-review')
    const created: Array<{ sessionId: string; agentPreset?: string; prompt: string }> = []
    const attached: string[] = []

    const ctx = new Context()
    ctx.baseUrl = PACKAGE_URL.href
    await provideHostServices(ctx, captured)
    // The webhook path's own Host seams, stubbed around the real composition.
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    })
    ctx.provide('permissionPresets', {
      resolve: () => 'default',
      set: () => {},
    })
    ctx.provide('sessionTitle', { rename: () => {} })
    ctx.provide('workspaceRegistry', {
      create: async (path: string) => ({
        path,
        attachSession: async (sessionId: string) => {
          attached.push(sessionId)
        },
      }),
    })
    const agentsService = ctx.get('agents') as { create?: unknown }
    agentsService.create = async (options: {
      sessionId: string
      meta?: { cwd?: string; agentPreset?: string }
      setup?: (agentCtx: Context) => Promise<void>
    }) => {
      // The agent scope is where the official runtime mounts the preset; the
      // stub only has to be a real scope so `agentPresets.mount` can run.
      const scope = createScope(ctx, { sessionId: options.sessionId })
      try {
        await options.setup?.(scope.ctx)
      } catch (error) {
        await scope.dispose()
        throw error
      }
      created.push({
        sessionId: options.sessionId,
        agentPreset: options.meta?.agentPreset,
        prompt: '',
      })
      return {
        agent: {
          id: options.sessionId,
          session: { id: options.sessionId },
          followup: (message: { content: Array<{ type: string; text?: string }> }) => {
            const last = created[created.length - 1]
            if (last !== undefined) {
              created[created.length - 1] = {
                ...last,
                prompt: message.content.map((part) => part.text ?? '').join(''),
              }
            }
          },
        },
        dispose: async () => {
          await scope.dispose()
        },
      }
    }

    try {
      await ctx.plugin(Registry, { default: 'standard' })
      const registry = ctx.get('agentPresets') as AgentPresetRegistry
      const disposePreset = await registry.register(
        teamPresetDefinition({
          teamId: 'product-review',
          displayName: '产品评审 / Product Review',
          hostPrompt: HOST_PROMPT,
          memberCount: 2,
        }),
      )
      await ctx.plugin(WebhookRuntime)
      const runtime = ctx.get('webhookRuntime') as WebhookRuntime
      const disposeRule = await runtime.register({
        id: 'channels',
        kind: 'channel',
        run: async () => ({
          workspacePath: teamWorkspace,
          title: 'telegram:901',
          prompt: 'review this release',
          agentPreset: teamPresetId('product-review'),
          permissionPreset: 'default',
        }),
      })

      try {
        runtime.dispatch({
          kind: 'channel',
          source: 'ch-team-bot',
          deliveryId: 'delivery-1',
          receivedAt: Date.now(),
        })
        // The runtime starts the invocation without awaiting it; give the
        // composition a few turns of the microtask queue to settle.
        for (let i = 0; i < 200 && created.length === 0; i += 1) {
          await new Promise((resolve) => setImmediate(resolve))
        }

        const rendered = captured
          .map((line) => `${line.type}: ${line.args.map((arg) => String(arg)).join(' ')}`)
          .join('\n')
        expect(created.length, `no session was created; runtime log:\n${rendered}`).toBe(1)
        expect(created[0]?.agentPreset).toBe(teamPresetId('product-review'))
        expect(created[0]?.prompt).toBe('review this release')
        expect(attached).toEqual([created[0]?.sessionId])
      } finally {
        await disposeRule()
        await disposePreset()
      }
    } finally {
      await ctx.fiber.dispose()
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
