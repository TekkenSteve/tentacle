/**
 * @tentacle/channels — IM channels for DSH
 * (design: docs/design/06-channels.md).
 *
 * The plugin is transactional (matching every other Tentacle plugin): it
 * requires `tentacleTenancy` (identity binding is the access-control story)
 * and `webhookRuntime` (a message that cannot reach an agent is not a
 * feature). The gateway is optional — without it only the admin REST surface
 * is missing.
 */
import type { Context } from '@deepseek-ai/cordis'
import { TentacleChannels, type TentacleChannelsConfig } from './service.js'

export const name = 'tentacle-channels'
export const inject = ['tentacleTenancy', 'webhookRuntime', 'storageDomain']

export {
  TentacleChannels,
  type TentacleChannelsConfig,
  type ChannelServices,
  type ChannelAdapterFactory,
  type ChannelCredentialView,
  type ChannelHookHandler,
  type ChannelHookReply,
  type ChannelHookRequest,
  type ChannelInstanceView,
  type ChannelOverview,
  type InstanceRuntime,
  type ProbeResult,
  type TelegramChannelConfig,
} from './service.js'
export { BindingStore, BindingsError, type BindInput, type TenancyDirectory } from './bindings.js'
export { ProvisionError, ProvisionSessions, type ProvisionFlow, type ProvisionSession, type ProvisionStart, type ProvisionPoll, type ProvisionStatus } from './provision.js'
export {
  MemoryStore,
  bindingKey,
  conversationKey,
  emptyGlobal,
  type ChannelsGlobal,
  type ChannelsStore,
  type ChannelBinding,
  type ConversationIdentity,
  type ConversationLink,
  type Table,
} from './repo.js'
export { CHANNELS_DOMAIN, openChannelsStore } from './storage.js'
export {
  ChannelError,
  allSchemas,
  isChannelType,
  normalizeName,
  requireChannelType,
  schemaOf,
  validateConfig,
  type ChannelErrorCode,
  type ChannelInstance,
  type ChannelTypeSchema,
  type CredentialSpec,
  type FieldKind,
  type FieldSpec,
} from './instances.js'
export {
  ChannelRegistry,
  type ChannelActor,
  type ChannelRegistryDeps,
  type CreateChannelInput,
  type UpdateChannelInput,
} from './registry.js'
export {
  RecordCredentials,
  UnavailableCredentials,
  channelCredentialKey,
  type CredentialStatus,
  type CredentialValues,
  type InstanceCredentials,
} from './credentials.js'
export { createChannelRoutes, CHANNELS_ADMIN_PREFIX, errorStatus, type ChannelAdminApi } from './admin-api.js'
export { SessionRouter, assistantTextOf, canonicalize, turnReasonKind, type SessionRouterOptions, type SessionEventSink, type WebhookDispatchPort, type AgentRegistryPort } from './router/router.js'
export { TelegramAdapter, TELEGRAM_MESSAGE_LIMIT, contentPartsOf, isAddressedToBot, splitMessage, subjectOf, type TelegramAdapterConfig } from './adapter/telegram.js'
export { createTelegramApi, TelegramError, type TelegramApi, type TelegramApiOptions, type Update } from './adapter/telegram-api.js'
export { DINGTALK_CHANNEL_TYPE, DINGTALK_CHATBOT_TOPIC, DINGTALK_MESSAGE_LIMIT, DingTalkAdapter, dingtalkContentParts, stripAtMention, type DingTalkAdapterConfig, type DingTalkChatbotData, type DingTalkCredentials } from './adapter/dingtalk.js'
export { createDingTalkApi, DingTalkError, DEFAULT_DINGTALK_API_BASE_URL, DEFAULT_DINGTALK_STREAM_URL, type DingTalkApi, type DingTalkApiOptions, type DingTalkConnection, type DingTalkErrorCode } from './adapter/dingtalk-api.js'
export { WeComAdapter, WECOM_CHANNEL_TYPE, WECOM_MESSAGE_LIMIT, weComContentParts, type WeComAdapterConfig, type WeComCredentials, type WeComMessageBody } from './adapter/wecom.js'
export { createWeComApi, generateWeComReqId, WeComError, WECOM_DEFAULT_WS_URL, WECOM_HEARTBEAT_INTERVAL_MS, WECOM_RECONNECT_BASE_DELAY_MS, WECOM_RECONNECT_MAX_DELAY_MS, WECOM_REPLY_ACK_TIMEOUT_MS, type WeComApi, type WeComApiOptions, type WeComErrorCode, type WeComFrame, type WeComStreamReply } from './adapter/wecom-api.js'
export { QQAdapter, QQ_CHANNEL_TYPE, QQ_DEFAULT_INTENTS, QQ_MESSAGE_LIMIT, isQQBotMentioned, qqContentParts, type QQAdapterConfig, type QQCredentials, type QQWebSocket, type QQWebSocketFactory } from './adapter/qq.js'
export { createQQApi, QQError, DEFAULT_QQ_API_BASE_URL, DEFAULT_QQ_ACCESS_TOKEN_URL, type QQApi, type QQApiOptions, type QQErrorCode, type QQMessageType } from './adapter/qq-api.js'
export { WeixinAdapter, WEIXIN_CHANNEL_TYPE, WEIXIN_MESSAGE_LIMIT, weixinContentParts, type WeixinAdapterConfig, type WeixinCredentials } from './adapter/weixin.js'
export { createWeixinApi, WeixinError, WEIXIN_DEFAULT_BASE_URL, WEIXIN_DEFAULT_LONG_POLL_MS, type WeixinApi, type WeixinApiOptions, type WeixinErrorCode, type WeixinCdnMedia, type WeixinMessage, type WeixinMessageItem, type WeixinUpdates, type WeixinSendResult } from './adapter/weixin-api.js'
export { DingTalkProvisionFlow, type DingTalkProvisionOptions } from './provision/dingtalk.js'
export { WeComProvisionFlow, WECOM_QR_TTL_MS, weComPlatCode, type WeComProvisionOptions } from './provision/wecom.js'
export { QQProvisionFlow, decryptQQSecret, type QQProvisionOptions } from './provision/qq.js'
export { WeixinProvisionFlow, type WeixinProvisionOptions } from './provision/weixin.js'
export { YuanbaoAdapter, YUANBAO_CHANNEL_TYPE, YUANBAO_PING_INTERVAL_MS, YUANBAO_RECONNECT_DELAYS_MS, isYuanbaoGroupAddressed, normalizeYuanbaoMediaUrl, yuanbaoContentParts, type YuanbaoAdapterConfig, type YuanbaoCredentials, type YuanbaoWebSocket, type YuanbaoWebSocketFactory } from './adapter/yuanbao.js'
export { createYuanbaoApi, computeYuanbaoSignature, normalizeYuanbaoApiDomain, yuanbaoTimestamp, YuanbaoError, type YuanbaoApi, type YuanbaoApiOptions, type YuanbaoErrorCode, type YuanbaoToken } from './adapter/yuanbao-api.js'
export * from './adapter/yuanbao-frames.js'
export { YuanbaoProvisionFlow, YuanbaoProvisionError, type YuanbaoProvisionOptions } from './provision/yuanbao.js'
export { DiscordAdapter, DISCORD_CHANNEL_TYPE, DISCORD_MESSAGE_LIMIT, DISCORD_DEFAULT_INTENTS, discordContentParts, type DiscordAdapterConfig, type DiscordCredentials, type DiscordWebSocket, type DiscordWebSocketFactory } from './adapter/discord.js'
export { createDiscordApi, DEFAULT_DISCORD_API_BASE_URL, type DiscordApi, type DiscordApiOptions, type DiscordUser } from './adapter/discord-api.js'
export { DiscordError, type DiscordErrorCode } from './adapter/discord-error.js'
export { FeishuAdapter, FEISHU_MESSAGE_LIMIT, cleanMentionPlaceholders, decryptEvent, feishuContentParts, isMentioned, type FeishuAdapterConfig, type FeishuCredentials } from './adapter/feishu.js'
export { createFeishuApi, FeishuError, type FeishuApi, type FeishuApiOptions, type FeishuBotInfo, type FeishuErrorCode } from './adapter/feishu-api.js'
export * from './types.js'

export function apply(ctx: Context, config?: TentacleChannelsConfig): void {
  ctx.plugin(TentacleChannels, config)
}
