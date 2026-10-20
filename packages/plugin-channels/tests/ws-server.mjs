/**
 * Bridge so repo-root e2e scripts (plain .mjs) can use the `ws` devDependency
 * of this package: ESM resolves imports relative to the importing FILE, and
 * this file sits inside the channels package whose node_modules links `ws`.
 */
export { WebSocketServer } from 'ws'
