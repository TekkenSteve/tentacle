import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as dataPlugin from '../src/index.js'
import { listWorkspaceDirectory, readWorkspaceFile, WorkspaceFileError } from '../src/connectors/workspace.js'
import type { TentacleData } from '../src/service.js'

function workspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tentacle-workspace-'))
  writeFileSync(join(root, 'sales.csv'), 'month,revenue\nJan,10\nFeb,20\n')
  writeFileSync(join(root, 'notes.txt'), 'not data')
  mkdirSync(join(root, 'nested'))
  writeFileSync(join(root, 'nested', 'regions.json'), '[{"region":"north"},{"region":"south"}]')
  return root
}

describe('workspace file connector', () => {
  it('lists directories and only CSV/JSON files', () => {
    const root = workspaceRoot()
    const listing = listWorkspaceDirectory(root)
    expect(listing.entries.map((entry) => `${entry.type}:${entry.name}`)).toEqual(['directory:nested', 'file:sales.csv'])
    const nested = listWorkspaceDirectory(root, 'nested')
    expect(nested.entries[0]).toMatchObject({ name: 'regions.json', type: 'file' })
    expect(nested.parent).toBe('')
  })

  it('reads CSV and JSON with format inference', () => {
    const root = workspaceRoot()
    expect(readWorkspaceFile(root, 'sales.csv')).toMatchObject({ name: 'sales', format: 'csv', relativePath: 'sales.csv' })
    expect(readWorkspaceFile(root, 'nested/regions.json')).toMatchObject({ format: 'json' })
  })

  it('refuses traversal and symlink escapes', () => {
    const root = workspaceRoot()
    expect(() => readWorkspaceFile(root, '../outside.csv')).toThrowError(WorkspaceFileError)
    const outside = mkdtempSync(join(tmpdir(), 'tentacle-outside-'))
    writeFileSync(join(outside, 'secret.csv'), 'a\n1\n')
    symlinkSync(outside, join(root, 'escape'))
    expect(() => listWorkspaceDirectory(root, 'escape')).toThrowError(/escapes the workspace/)
  })

  it('imports a workspace file through the service', async () => {
    const root = workspaceRoot()
    const app = new Context()
    const fiber = app.plugin(dataPlugin, {
      stateRoot: mkdtempSync(join(tmpdir(), 'tentacle-data-')),
      workspaceRegistry: { list: () => [{ id: 'w1', title: 'Demo', path: root }] },
    })
    await fiber
    const service = app.tentacleData as TentacleData
    await service.ready
    const dataWorkspace = service.stateSnapshot().workspaces[0]!
    const sources = service.workspaceSources()
    expect(sources).toEqual([{ id: 'w1', title: 'Demo', path: root }])
    expect(service.listWorkspaceFiles('w1', '').entries.some((entry) => entry.name === 'sales.csv')).toBe(true)
    const dataset = await service.importWorkspaceFile({ dataWorkspaceId: dataWorkspace.id, dshWorkspaceId: 'w1', path: 'sales.csv', name: '' })
    expect(dataset.name).toBe('sales')
    expect(dataset.rowCount).toBe(2)
    expect(dataset.source).toMatchObject({ kind: 'workspace', path: 'sales.csv' })
    writeFileSync(join(root, 'sales.csv'), 'month,revenue\nJan,10\nFeb,20\nMar,30\n')
    const refreshed = await service.refreshDataset(dataset.id)
    expect(refreshed.rowCount).toBe(3)
    expect(refreshed.source).toMatchObject({ kind: 'workspace', dshWorkspaceId: 'w1' })
  })
})
