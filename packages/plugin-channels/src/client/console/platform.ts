/**
 * Presentation metadata for the channel platforms the console can create.
 *
 * The host schema names a platform by `channelType` only; labels and icons are
 * a client concern. Unknown types fall back to the raw type and its initial so
 * a new adapter stays usable before this table grows.
 */
export interface PlatformMeta {
  readonly label: string
  readonly emoji: string
}

const PLATFORMS: Readonly<Record<string, PlatformMeta>> = {
  telegram: { label: 'Telegram', emoji: '✈️' },
  feishu: { label: '飞书 / Feishu', emoji: '🐦' },
  lark: { label: 'Lark', emoji: '🌐' },
  dingtalk: { label: '钉钉 / DingTalk', emoji: '🔔' },
  weixin: { label: '微信 / WeChat', emoji: '💬' },
  wecom: { label: '企业微信 / WeCom', emoji: '🏢' },
  qq: { label: 'QQ', emoji: '🐧' },
  discord: { label: 'Discord', emoji: '🎮' },
  slack: { label: 'Slack', emoji: '🧩' },
  webhook: { label: 'Webhook', emoji: '🪝' },
}

export function platformMeta(channelType: string): PlatformMeta {
  return PLATFORMS[channelType] ?? { label: channelType, emoji: channelType.slice(0, 1).toUpperCase() || '·' }
}
