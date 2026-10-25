/**
 * Object-store connectors (S3-compatible / Azure Blob).
 *
 * One-shot credentials: list CSV/JSON objects under a prefix, then import one
 * object's bytes. SDKs load lazily; credentials are never persisted.
 */
const MAX_OBJECT_BYTES = 20 * 1024 * 1024
const MAX_OBJECTS = 200

export type ObjectStoreProvider = 's3' | 'azure'

export interface S3Config {
  readonly provider: 's3'
  readonly bucket: string
  readonly region: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly endpoint?: string
  readonly prefix?: string
}

export interface AzureBlobConfig {
  readonly provider: 'azure'
  readonly container: string
  readonly connectionString: string
  readonly prefix?: string
}

export type ObjectStoreConfig = S3Config | AzureBlobConfig

export interface ObjectEntry {
  readonly key: string
  readonly size?: number
  readonly lastModified?: string
}

export interface ObjectReadResult {
  readonly content: string
  readonly format: 'csv' | 'json'
}

export interface ObjectStoreDriver {
  listObjects(config: ObjectStoreConfig): Promise<readonly ObjectEntry[]>
  readObject(config: ObjectStoreConfig, key: string): Promise<ObjectReadResult>
}

export class ObjectStoreError extends Error {
  constructor(readonly code: 'invalid-config' | 'connection-failed' | 'object-failed' | 'unsupported-object' | 'object-too-large', message: string) {
    super(message)
    this.name = 'ObjectStoreError'
  }
}

function formatOf(key: string): 'csv' | 'json' | undefined {
  const lower = key.toLowerCase()
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.json')) return 'json'
  return undefined
}

/** Validate and trim an untrusted object-store configuration. */
export function normalizeObjectStoreConfig(input: ObjectStoreConfig): ObjectStoreConfig {
  if (input.provider === 's3') {
    const bucket = input.bucket.trim()
    const region = input.region.trim()
    const accessKeyId = input.accessKeyId.trim()
    const secretAccessKey = input.secretAccessKey.trim()
    if (bucket === '' || region === '' || accessKeyId === '' || secretAccessKey === '') {
      throw new ObjectStoreError('invalid-config', 'bucket, region and credentials are required')
    }
    const endpoint = input.endpoint?.trim() ?? ''
    return {
      provider: 's3', bucket, region, accessKeyId, secretAccessKey,
      ...(endpoint === '' ? {} : { endpoint }),
      ...(input.prefix === undefined || input.prefix.trim() === '' ? {} : { prefix: input.prefix.trim() }),
    }
  }
  if (input.provider === 'azure') {
    const container = input.container.trim()
    const connectionString = input.connectionString.trim()
    if (container === '' || connectionString === '') throw new ObjectStoreError('invalid-config', 'container and connection string are required')
    return {
      provider: 'azure', container, connectionString,
      ...(input.prefix === undefined || input.prefix.trim() === '' ? {} : { prefix: input.prefix.trim() }),
    }
  }
  throw new ObjectStoreError('invalid-config', `unsupported provider: ${String((input as { provider?: unknown }).provider)}`)
}

function entryOf(key: string, size?: number, lastModified?: Date | string): ObjectEntry {
  const format = formatOf(key)
  if (format === undefined) throw new ObjectStoreError('unsupported-object', `only CSV/JSON objects are supported: ${key}`)
  if (size !== undefined && size > MAX_OBJECT_BYTES) throw new ObjectStoreError('object-too-large', `object is larger than 20 MB: ${key}`)
  return {
    key,
    ...(size === undefined ? {} : { size }),
    ...(lastModified === undefined ? {} : { lastModified: lastModified instanceof Date ? lastModified.toISOString() : lastModified }),
  }
}

/** S3-compatible driver (lazy `@aws-sdk/client-s3` import). */
export const s3Driver: ObjectStoreDriver = {
  async listObjects(config) {
    if (config.provider !== 's3') throw new ObjectStoreError('invalid-config', 's3 driver needs an s3 config')
    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3')
    const client = new S3Client({
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint, forcePathStyle: true }),
    })
    try {
      const response = await client.send(new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: config.prefix ?? '',
        MaxKeys: MAX_OBJECTS,
      }))
      return (response.Contents ?? [])
        .filter((object): object is { Key: string; Size?: number; LastModified?: Date } => typeof object.Key === 'string')
        .flatMap((object) => {
          try { return [entryOf(object.Key, object.Size, object.LastModified)] } catch { return [] }
        })
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error
      throw new ObjectStoreError('connection-failed', error instanceof Error ? error.message : String(error))
    }
  },
  async readObject(config, key) {
    if (config.provider !== 's3') throw new ObjectStoreError('invalid-config', 's3 driver needs an s3 config')
    const format = formatOf(key)
    if (format === undefined) throw new ObjectStoreError('unsupported-object', `only CSV/JSON objects are supported: ${key}`)
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3')
    const client = new S3Client({
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint, forcePathStyle: true }),
    })
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
      if (response.ContentLength !== undefined && response.ContentLength > MAX_OBJECT_BYTES) {
        throw new ObjectStoreError('object-too-large', 'object is larger than 20 MB')
      }
      const bytes = await response.Body?.transformToByteArray()
      if (bytes === undefined) throw new ObjectStoreError('object-failed', 'object body was empty')
      if (bytes.length > MAX_OBJECT_BYTES) throw new ObjectStoreError('object-too-large', 'object is larger than 20 MB')
      return { content: Buffer.from(bytes).toString('utf8'), format }
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error
      throw new ObjectStoreError('object-failed', error instanceof Error ? error.message : String(error))
    }
  },
}

/** Azure Blob driver (lazy `@azure/storage-blob` import). */
export const azureBlobDriver: ObjectStoreDriver = {
  async listObjects(config) {
    if (config.provider !== 'azure') throw new ObjectStoreError('invalid-config', 'azure driver needs an azure config')
    const { BlobServiceClient } = await import('@azure/storage-blob')
    try {
      const service = BlobServiceClient.fromConnectionString(config.connectionString)
      const container = service.getContainerClient(config.container)
      const entries: ObjectEntry[] = []
      for await (const blob of container.listBlobsFlat({ prefix: config.prefix ?? '' })) {
        try { entries.push(entryOf(blob.name, blob.properties.contentLength, blob.properties.lastModified)) } catch { /* skip non-data objects */ }
        if (entries.length >= MAX_OBJECTS) break
      }
      return entries
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error
      throw new ObjectStoreError('connection-failed', error instanceof Error ? error.message : String(error))
    }
  },
  async readObject(config, key) {
    if (config.provider !== 'azure') throw new ObjectStoreError('invalid-config', 'azure driver needs an azure config')
    const format = formatOf(key)
    if (format === undefined) throw new ObjectStoreError('unsupported-object', `only CSV/JSON objects are supported: ${key}`)
    const { BlobServiceClient } = await import('@azure/storage-blob')
    try {
      const service = BlobServiceClient.fromConnectionString(config.connectionString)
      const blob = service.getContainerClient(config.container).getBlobClient(key)
      const buffer = await blob.downloadToBuffer()
      if (buffer.length > MAX_OBJECT_BYTES) throw new ObjectStoreError('object-too-large', 'object is larger than 20 MB')
      return { content: buffer.toString('utf8'), format }
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error
      throw new ObjectStoreError('object-failed', error instanceof Error ? error.message : String(error))
    }
  },
}

export function createObjectStoreDriver(provider: ObjectStoreProvider): ObjectStoreDriver {
  return provider === 's3' ? s3Driver : azureBlobDriver
}
