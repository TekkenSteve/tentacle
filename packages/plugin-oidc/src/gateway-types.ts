/** The narrow gateway surface this package consumes (no implementation import). */
export interface GatewayRoute {
  readonly prefix: string
  readonly public?: boolean
  handler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void | Promise<void>
}
