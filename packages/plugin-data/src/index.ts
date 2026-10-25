/**
 * @tentacle/data — Data Studio for DSH (design 11).
 *
 * Host half: a persisted data workspace service (datasets, threads, chart
 * cards) plus the admin REST surface. The browser half is a global main panel
 * that renders the Data Formulator-style thread board over that surface.
 */
import type { Context } from '@deepseek-ai/cordis'
import { TentacleData, type TentacleDataConfig } from './service.js'

export const name = 'tentacle-data'

export {
  TentacleData,
  DataError,
  type TentacleDataConfig,
  type ImportDatasetInput,
  type CreateThreadInput,
  type CardInput,
  type CardPatch,
} from './service.js'
export { DataRepo } from './repo.js'
export { parseCsv, parseCsvDataset, parseJsonDataset, parseDataset, inferType, DatasetParseError, type ParsedDataset } from './parser.js'
export { applyOperation, validateOperation, describeOperation } from './operations.js'
export { recommendCharts, type ChartRecommendation } from './shared/recommend.js'
export { createDataRoutes, DATA_ADMIN_PREFIX, type DataAdminApi } from './admin-api.js'
export * from './types.js'

export function apply(ctx: Context, config?: TentacleDataConfig): void {
  ctx.plugin(TentacleData, config)
}
