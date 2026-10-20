/**
 * Expert template catalog (design: 09-experts §2; the reference implementation's
 * `experts/catalog.py` ported to the filesystem).
 *
 * A template is a directory: `manifest.json` (bilingual identity + welcome +
 * quick prompts) plus arbitrary seed files (`SOUL.md`, `skills/…`). Creating an
 * instance from a template copies every seed file into that instance's
 * workspace and snapshots the manifest to `.tentacle/manifest.json`; later
 * template upgrades never touch existing instances (the reference implementation's detach rule).
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { ExpertTemplate, ExpertTemplateManifest, LocalizedText, QuickPrompt } from './types.js'

/** Workspace snapshot path for the template manifest (welcome/quick-prompt source). */
export const WORKSPACE_MANIFEST_PATH = '.tentacle/manifest.json'

export interface TemplateLoadResult {
  readonly templates: readonly ExpertTemplate[]
  /** One human-readable line per rejected template; a bad template never kills boot. */
  readonly errors: readonly string[]
}

function isLocalized(value: unknown): value is LocalizedText {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { zh?: unknown; en?: unknown }
  return typeof candidate.zh === 'string' && candidate.zh.trim() !== ''
    && typeof candidate.en === 'string' && candidate.en.trim() !== ''
}

function parseQuickPrompts(raw: unknown): QuickPrompt[] {
  if (!Array.isArray(raw)) return []
  const prompts: QuickPrompt[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as { title?: unknown; prompt?: unknown }
    if (!isLocalized(candidate.title) || !isLocalized(candidate.prompt)) continue
    prompts.push({ title: candidate.title, prompt: candidate.prompt })
  }
  return prompts
}

function parseManifest(raw: unknown): ExpertTemplateManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('manifest must be an object')
  const candidate = raw as Record<string, unknown>
  if (typeof candidate['id'] !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(candidate['id'])) {
    throw new Error('manifest.id must be a slug')
  }
  if (!isLocalized(candidate['label'])) throw new Error('manifest.label requires zh and en text')
  if (!isLocalized(candidate['description'])) throw new Error('manifest.description requires zh and en text')
  const optional = (key: string): string | undefined =>
    typeof candidate[key] === 'string' && (candidate[key] as string).trim() !== '' ? (candidate[key] as string).trim() : undefined
  return {
    id: candidate['id'],
    label: candidate['label'],
    description: candidate['description'],
    ...(isLocalized(candidate['welcome_message']) ? { welcomeMessage: candidate['welcome_message'] } : {}),
    ...(optional('icon') === undefined ? {} : { icon: optional('icon') }),
    ...(optional('color') === undefined ? {} : { color: optional('color') }),
    quickPrompts: parseQuickPrompts(candidate['quick_prompts']),
    ...(typeof candidate['agent_preset'] === 'string' && candidate['agent_preset'].trim() !== ''
      ? { agentPreset: candidate['agent_preset'].trim() }
      : {}),
  }
}

/** Every file under the template dir, workspace-relative, manifest excluded. */
function discoverSeedFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        const rel = relative(root, full).split(sep).join('/')
        if (rel !== 'manifest.json') files.push(rel)
      }
    }
  }
  walk(root)
  return files.sort()
}

/** Scan a templates root (missing root = empty catalog, never an error). */
export function loadTemplates(root: string): TemplateLoadResult {
  const templates: ExpertTemplate[] = []
  const errors: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { templates, errors }
    throw error
  }
  for (const name of entries.sort()) {
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      const manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
      if (manifest.id !== name) throw new Error(`manifest.id "${manifest.id}" must match directory "${name}"`)
      templates.push({ manifest, dir, files: discoverSeedFiles(dir) })
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { templates, errors }
}

/**
 * Copy a template into an instance workspace (the reference implementation's `seed_expert_directory`).
 * Both the seed files and the manifest snapshot are written fresh; the caller
 * only does this at creation, so later template edits cannot leak in.
 */
export function seedTemplate(template: ExpertTemplate, workspaceDir: string): void {
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 })
  for (const rel of template.files) {
    const target = join(workspaceDir, rel)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    copyFileSync(join(template.dir, rel), target)
  }
  const manifestPath = join(workspaceDir, WORKSPACE_MANIFEST_PATH)
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 })
  writeFileSync(manifestPath, JSON.stringify(template.manifest, null, 2) + '\n', { mode: 0o600 })
}
