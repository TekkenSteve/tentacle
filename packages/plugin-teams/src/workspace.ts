/**
 * Team workspace seeding and member-skill materialization (design 10 §4).
 *
 * The team workspace is the session cwd shared by the Lead and every
 * teammate (the official runtime shares one cwd — there is no per-member
 * workspace). Two things live in it:
 *
 *  1. **Generated artifacts** — `SOUL.md` (the rendered host prompt, kept as
 *     a readable copy; the mounted persona comes from the preset row, never
 *     from this file) and `.tentacle/manifest.json` (the manifest snapshot
 *     the console reads welcome copy and quick prompts from).
 *  2. **Materialized member skills** — `<workspace>/.dsh/skills/<memberId>/…`,
 *     copied from each member expert's workspace. Members cannot read the
 *     experts' workspaces (file-sandbox cwd fence), so a member who needs
 *     its skills needs them HERE. Copying also keeps the team workspace
 *     self-contained, which is what a future team export builds on.
 *
 * Materialization is a full rebuild of the skills subtree: the tree is
 * generated data, so a stale member's skills disappear with the member and
 * a hand edit is replaced on the next refresh (edit the source expert).
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Team, TeamTemplateManifest } from './types.js'

/** Workspace snapshot path for the team manifest (welcome/quick-prompt source). */
export const TEAM_WORKSPACE_MANIFEST_PATH = '.tentacle/manifest.json'
/** The DSH skills root inside a workspace (discovered by dsh-skill-filesystem). */
const SKILLS_ROOT = ['.dsh', 'skills']

/** Instance workspaces root. Default `<stateRoot>/agents`. */
export function teamWorkspaceRoot(stateRoot: string): string {
  return join(stateRoot, 'agents')
}

export function teamWorkspacePath(stateRoot: string, teamId: string): string {
  return join(teamWorkspaceRoot(stateRoot), teamId, 'workspace')
}

function skillsRootOf(workspaceDir: string): string {
  return join(workspaceDir, ...SKILLS_ROOT)
}

/** The manifest snapshot written into every team workspace. */
export function teamManifestSnapshot(team: Team): TeamTemplateManifest & { readonly id: string } {
  return {
    id: team.id,
    label: team.name,
    description: team.description,
    ...(team.welcomeMessage === undefined ? {} : { welcomeMessage: team.welcomeMessage }),
    ...(team.icon === undefined ? {} : { icon: team.icon }),
    ...(team.color === undefined ? {} : { color: team.color }),
    quickPrompts: team.quickPrompts,
    members: team.members,
    ...(team.contract.goal !== undefined
      || team.contract.constraints.length > 0
      || team.contract.delivery !== undefined
      || team.contract.examples.length > 0
      ? { contract: team.contract }
      : {}),
    collaboration: team.collaboration,
  }
}

/**
 * Write the generated artifacts into a team workspace. `hostPrompt` is the
 * same text the preset mounts — one render, two homes, no drift.
 */
export function seedTeamWorkspace(
  workspaceDir: string,
  team: Team,
  hostPrompt: string,
): void {
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(workspaceDir, 'SOUL.md'),
    [
      '<!-- 由团队数据生成（设计 10 §5）；请修改团队本身，不要手改此文件。 -->',
      '<!-- The mounted host persona comes from the team preset row, not this file. -->',
      '',
      hostPrompt,
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  const manifestPath = join(workspaceDir, TEAM_WORKSPACE_MANIFEST_PATH)
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 })
  writeFileSync(manifestPath, JSON.stringify(teamManifestSnapshot(team), null, 2) + '\n', { mode: 0o600 })
}

/** One member's skills root (the expert workspace's `.dsh/skills`). */
export interface MemberSkillSource {
  readonly expertId: string
  readonly skillsRoot: string
}

/**
 * Rebuild `<workspace>/.dsh/skills` from the member sources: every member's
 * skills land under `<memberId>/`, so two members with a same-named skill
 * never collide. Returns the materialized `<memberId>/<skill>` paths
 * (workspace-relative), for the console and tests.
 */
export function materializeMemberSkills(
  workspaceDir: string,
  sources: readonly MemberSkillSource[],
): readonly string[] {
  const target = skillsRootOf(workspaceDir)
  rmSync(target, { recursive: true, force: true })
  const materialized: string[] = []
  for (const source of sources) {
    if (!existsSync(source.skillsRoot)) continue
    for (const entry of readdirSync(source.skillsRoot)) {
      const from = join(source.skillsRoot, entry)
      if (!statSync(from).isFile() && !statSync(from).isDirectory()) continue
      const to = join(target, source.expertId, entry)
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
      if (statSync(from).isDirectory()) cpSync(from, to, { recursive: true })
      else copyFileSync(from, to)
      materialized.push(`${source.expertId}/${entry}`)
    }
  }
  return materialized.sort()
}

/**
 * Every materialized skill of a team workspace, as `<memberId>/<skill>`
 * entries (a skill is a directory with SKILL.md, or a single .md file — the
 * same shape the expert library lists). Mirrors {@link materializeMemberSkills}.
 */
export function listMaterializedSkills(workspaceDir: string): readonly string[] {
  const root = skillsRootOf(workspaceDir)
  if (!existsSync(root)) return []
  const skills: string[] = []
  for (const member of readdirSync(root)) {
    const memberDir = join(root, member)
    if (!statSync(memberDir).isDirectory()) continue
    for (const entry of readdirSync(memberDir)) skills.push(`${member}/${entry}`)
  }
  return skills.sort()
}
