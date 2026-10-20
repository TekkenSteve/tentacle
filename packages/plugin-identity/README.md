# @tentacle/identity

English | [中文](README.zh.md)

Pluggable identity for DeepSeek Harness — the foundation of the Tentacle bundle.

- **subjectId**: every identity is an Ed25519 keypair; the public key derives a self-contained `did:key` subjectId. No network resolution needed.
- **Provider registry**: the built-in `LocalProvider` is the zero-config default (auto-provisions into the state root, 0600). Third-party providers are separate packages registering via `inject: ['tentacleIdentity']` + `ctx.tentacleIdentity.registerProvider()`.
- **Secrets never leave the Host**: only the public `Identity` DTO crosses boundaries; signing capability is never exposed as a Remote.

Design: [docs/design/01-identity.md](../../docs/design/01-identity.md).

## Usage

```yaml
- id: tentacle-identity
  name: '@tentacle/identity'
  config:
    stateRoot: /path/to/state   # default: <cwd>/.tentacle/identity
    tenant: local               # default tenant id
```

```ts
const identity = await ctx.tentacleIdentity.current()
// { subjectId: 'did:key:z6Mk…', tenant: 'local', createdAt: … }
```

## License

MIT
