/**
 * TentacleIdentity — the Cordis service other Tentacle plugins consume.
 *
 * Registry model (D3): providers register themselves (`inject: ['tentacleIdentity']`
 * + `ctx.tentacleIdentity.registerProvider(...)`), the service boots the active
 * one. The local provider is the built-in zero-config default (D2), so every
 * deployment — single-user included — runs the same code path.
 */
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { LocalProvider } from './local-provider.js'
import type { Identity, IdentityProvider, SubjectId } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tentacleIdentity: TentacleIdentity
  }
}

export interface TentacleIdentityConfig {
  /** State root for the local provider. Defaults to `<cwd>/.tentacle/identity`. */
  stateRoot?: string
  /** Provider kind to activate. Default: 'local'. */
  provider?: string
  /** Default tenant for the local provider. Default: 'local'. */
  tenant?: string
}

export class TentacleIdentity extends Service {
  private providers = new Map<string, IdentityProvider>()
  private active: IdentityProvider | undefined

  constructor(
    ctx: import('@deepseek-ai/cordis').Context,
    private readonly config: TentacleIdentityConfig = {},
  ) {
    super(ctx, 'tentacleIdentity')
  }

  /** Register a provider. Duplicate kinds fail loud — composition contract. */
  registerProvider(provider: IdentityProvider): () => void {
    if (this.providers.has(provider.kind)) {
      throw new Error(`tentacle identity: duplicate provider kind ${JSON.stringify(provider.kind)}`)
    }
    this.providers.set(provider.kind, provider)
    return () => {
      if (this.providers.get(provider.kind) === provider) this.providers.delete(provider.kind)
    }
  }

  protected async [Service.init](): Promise<void> {
    const kind = this.config.provider ?? 'local'
    if (kind === 'local' && !this.providers.has('local')) {
      this.registerProvider(new LocalProvider(
        this.config.stateRoot ?? join(dshHomePath(), 'tentacle', 'identity'),
        this.config.tenant,
      ))
    }
    const provider = this.providers.get(kind)
    if (!provider) throw new Error(`tentacle identity: no provider registered for kind ${JSON.stringify(kind)}`)
    await provider.boot()
    this.active = provider
  }

  /** The identity of the current local operator. */
  current(): Promise<Identity> {
    if (!this.active) throw new Error('tentacle identity: service not started')
    return this.active.current()
  }

  /** Resolve a subjectId through the active provider. */
  resolve(id: SubjectId): Promise<Identity | undefined> {
    if (!this.active) throw new Error('tentacle identity: service not started')
    return this.active.resolve(id)
  }

  /** Registered provider kinds, for admin surfaces. */
  listProviders(): string[] {
    return [...this.providers.keys()]
  }
}
