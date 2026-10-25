/**
 * Workspace-file connector.
 *
 * The host reads only inside a registered DSH Workspace: every requested path
 * is resolved against the workspace root, then realpath-checked again so a
 * symlink cannot escape. Only CSV/JSON files are exposed to Data Studio.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_FILE_BYTES = 20 * 1024 * 1024
const DATA_EXTENSIONS = new Set(['.csv', '.json'])

export class WorkspaceFileError extends Error {
  constructor(readonly code: 'invalid-path' | 'not-a-file' | 'unsupported-file' | 'file-too-large', message: string) {
    super(message)
    this.name = 'WorkspaceFileError'
  }
}

export interface WorkspaceFileEntry {
  readonly name: string
  readonly path: string
  readonly type: 'file' | 'directory'
  readonly size?: number
}

export interface WorkspaceFileListing {
  readonly path: string
  readonly parent?: string
  readonly entries: readonly WorkspaceFileEntry[]
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Resolve a relative path and realpath it, refusing traversal/symlink escapes. */
export function resolveInside(root: string, relativePath: string): { root: string; path: string } {
  if (isAbsolute(relativePath)) throw new WorkspaceFileError('invalid-path', 'path must be relative')
  const realRoot = realpathSync(root)
  const candidate = resolve(realRoot, relativePath)
  if (!inside(realRoot, candidate)) throw new WorkspaceFileError('invalid-path', 'path escapes the workspace')
  let real: string
  try {
    real = realpathSync(candidate)
  } catch {
    throw new WorkspaceFileError('invalid-path', 'path does not exist')
  }
  if (!inside(realRoot, real)) throw new WorkspaceFileError('invalid-path', 'path escapes the workspace')
  return { root: realRoot, path: real }
}

function toRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

/** List one directory level of a workspace. */
export function listWorkspaceDirectory(root: string, relativePath = ''): WorkspaceFileListing {
  const resolved = resolveInside(root, relativePath)
  const stat = statSync(resolved.path)
  if (!stat.isDirectory()) throw new WorkspaceFileError('invalid-path', 'path is not a directory')
  const entries: WorkspaceFileEntry[] = []
  for (const name of readdirSync(resolved.path)) {
    if (name.startsWith('.') || name === 'node_modules') continue
    const full = resolve(resolved.path, name)
    let info
    try { info = statSync(full) } catch { continue }
    if (info.isDirectory()) {
      entries.push({ name, path: relativePath === '' ? name : `${relativePath}/${name}`, type: 'directory' })
      continue
    }
    if (!info.isFile() || !DATA_EXTENSIONS.has(extname(name).toLowerCase())) continue
    entries.push({ name, path: relativePath === '' ? name : `${relativePath}/${name}`, type: 'file', size: info.size })
  }
  entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1)
  return {
    path: relativePath,
    ...(relativePath === '' ? {} : { parent: dirname(relativePath).split(sep).join('/') === '.' ? '' : dirname(relativePath).split(sep).join('/') }),
    entries,
  }
}

/** Read one CSV/JSON file from a workspace. */
export function readWorkspaceFile(root: string, relativePath: string): { name: string; format: 'csv' | 'json'; content: string; relativePath: string } {
  const resolved = resolveInside(root, relativePath)
  const stat = statSync(resolved.path)
  if (!stat.isFile()) throw new WorkspaceFileError('not-a-file', 'path is not a file')
  const extension = extname(resolved.path).toLowerCase()
  if (!DATA_EXTENSIONS.has(extension)) throw new WorkspaceFileError('unsupported-file', 'only CSV/JSON files are supported')
  if (stat.size > MAX_FILE_BYTES) throw new WorkspaceFileError('file-too-large', 'file is larger than 20 MB')
  return {
    name: basename(resolved.path, extension),
    format: extension === '.json' ? 'json' : 'csv',
    content: readFileSync(resolved.path, 'utf8'),
    relativePath: toRelative(root, resolved.path),
  }
}
