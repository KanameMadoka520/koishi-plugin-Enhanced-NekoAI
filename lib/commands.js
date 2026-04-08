/**
 * commands.js — 所有指令注册
 * 从原 index.js 迁移全部 ctx.command() 并新增 9 个指令
 */

const { h, sleep } = require('koishi');
const state = require('./state');
const logger = require('./logger');
const { isMaster, isBlacklisted, loadCommandsList, updateGroupFriends, getPeriodInfo, getGroupPersonalityIndex, getGroupApiIndex, getXaiWebSearchNotice, isKnownGroupFriend, getImageAccessConfig } = require('./utils');
const { loadAllConfigs, saveRuntimeConfig, saveApiConfig, saveGroupPersonality, savePrivatePersonality, saveUsageCounts } = require('./config');
const { clearGroupMemory, clearPrivateMemory, rescheduleAllMemoryCleanupTimers } = require('./memory');
const { SerializeMessage, sendReply } = require('./sender');
const { parseMessageContent, extractQuotedContent } = require('./parser');
const { generateXaiImages } = require('./api');
const { checkImageQuota, recordImageQuotaUsage, buildImageQuotaExceededMessage, buildImageQuotaUsageNotice } = require('./ratelimit');
const { appendUsageEvent } = require('./usage-events');
const { renderHelpMenuCard, renderPersonalityListCard, renderModelListCard, renderStatusPanelCard, MODEL_LIST_RENDER_PAGE_SIZE } = require('./render');

const UI_STYLE_LABELS = {
  1: '极光玻璃',
  2: '深色终端',
  3: '暖纸卡片',
};
const MODEL_SEARCH_PAGE_SIZE = 20;
const IMAGE_MODEL_LIST_PAGE_SIZE = 20;
const XAI_IMAGE_RATIO_OPTIONS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20'];
const XAI_IMAGE_RESOLUTION_OPTIONS = ['1k', '2k'];
const IMAGE_NOTICE_RECALL_MS = 30000;
const IMAGE_NOTICE_RECALL_HINT = '（30秒后本消息自动撤回）';

function getUiStyleLabel(mode) {
  return UI_STYLE_LABELS[Number(mode)] || UI_STYLE_LABELS[1];
}

function buildImagePromptPreview(prompt) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!text) return '[空提示词]';
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function buildImageSceneLabel(session) {
  return session?.isDirect ? `私聊:${session.userId}` : `群聊:${session.channelId}`;
}

function buildImageNodeLabel(apiNode, index) {
  return `#${index} ${apiNode?.remark || apiNode?.modelName || '未命名节点'}`;
}

function buildImageOptionSummary(options, extras = {}) {
  const parts = [];
  if (extras.requestedCount !== undefined) parts.push(`count=${extras.requestedCount}`);
  if (extras.sourceImageCount !== undefined) parts.push(`输入图=${extras.sourceImageCount}`);
  if (extras.currentImageCount !== undefined) parts.push(`当前消息图=${extras.currentImageCount}`);
  if (extras.quotedImageCount !== undefined) parts.push(`引用图=${extras.quotedImageCount}`);
  parts.push(`ratio=${String(options?.ratio || '').trim() || '[节点默认]'}`);
  parts.push(`resolution=${String(options?.resolution || '').trim() || '[节点默认]'}`);
  parts.push(`model=${String(options?.model || '').trim() || '[节点默认]'}`);
  if (Number.isInteger(Number(options?.node))) parts.push(`指定节点=${Number(options.node)}`);
  return parts.join(' ');
}

function stringifySendAck(ack) {
  if (Array.isArray(ack)) return ack.length ? ack.join(',') : '[empty]';
  if (ack === undefined || ack === null || ack === '') return '[empty]';
  return String(ack);
}

function scheduleImageNoticeRecall(session, messageIds, delayMs = IMAGE_NOTICE_RECALL_MS) {
  if (!messageIds) return;
  const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
  if (!ids.length) return;
  if (!session?.bot || typeof session.bot.deleteMessage !== 'function') return;
  if (!session.channelId) return;
  setTimeout(async () => {
    for (const id of ids) {
      if (!id) continue;
      try {
        await session.bot.deleteMessage(session.channelId, id);
      } catch (error) {
        logger.debug(`图像提示撤回失败(${id}): ${error?.message || '未知错误'}`);
      }
    }
  }, delayMs);
}

async function sendAutoRecallImageNotice(session, text, delayMs = IMAGE_NOTICE_RECALL_MS) {
  const messageIds = await session.send(text);
  scheduleImageNoticeRecall(session, messageIds, delayMs);
  return messageIds;
}

function canUseImageCommand(session) {
  const userId = String(session?.userId || '');
  const imageAccess = getImageAccessConfig();
  if (isBlacklisted(userId)) {
    return {
      allowed: false,
      isMasterUser: false,
      accessMode: imageAccess.mode,
      reason: 'blacklist',
      message: '❌ 黑名单用户不允许使用生图和修图功能。',
    };
  }
  if (isMaster(session)) return { allowed: true, isMasterUser: true, accessMode: imageAccess.mode, reason: 'master' };
  if (imageAccess.mode === 'whitelist') {
    if (imageAccess.whitelistUsers.includes(userId)) {
      return { allowed: true, isMasterUser: false, accessMode: 'whitelist', reason: 'whitelist-allowed' };
    }
    return {
      allowed: false,
      isMasterUser: false,
      accessMode: 'whitelist',
      reason: 'whitelist-required',
      message: '❌ 当前图像权限为白名单模式，只有被手动加入图像白名单的 QQ 才能使用生图和修图。',
    };
  }
  if (!session?.isDirect) return { allowed: true, isMasterUser: false, accessMode: 'blacklist', reason: 'blacklist-mode-group' };
  if (isKnownGroupFriend(session?.userId)) return { allowed: true, isMasterUser: false, accessMode: 'blacklist', reason: 'blacklist-mode-group-friend' };
  return {
    allowed: false,
    isMasterUser: false,
    accessMode: 'blacklist',
    reason: 'group-friend-required',
    message: '❌ 当前图像权限为黑名单模式：主人和群友可用；普通陌生私聊用户不可用。若你是群友但刚被放进新的监听群，请稍后让主人执行一次群友名单刷新。',
  };
}

function buildXaiImageOptionHintText() {
  return `宽高比支持：${XAI_IMAGE_RATIO_OPTIONS.join(' / ')}\n分辨率支持：${XAI_IMAGE_RESOLUTION_OPTIONS.join(' / ')}\n注意：宽高比里的冒号请使用英文冒号 ":"，例如 16:9，不要写成 16：9。`;
}

function buildXaiGenerateUsageText() {
  return `❌ 用法：neko.生图 【提示词】 [--count 1-10] [--ratio 16:9] [--resolution 2k] [--model grok-imagine-image] [--node 0]
示例1：neko.生图 赛博朋克夜雨里的猫娘 --ratio 16:9 --resolution 2k
示例2：neko.生图 Q版白发少女贴纸 --count 2 --ratio 1:1
说明：
${buildXaiImageOptionHintText()}
如果不想手动指定宽高比或分辨率，直接省略 --ratio / --resolution，命令会走当前图像节点里保存的默认值。`;
}

function buildXaiEditUsageText() {
  return `❌ 用法：neko.修图 【提示词】 [--ratio 1:1] [--resolution 1k] [--model grok-imagine-image] [--node 0]
示例1：neko.修图 给她加一顶黑色贝雷帽 --ratio 1:1
示例2：先引用一条带图消息，再发送：neko.修图 改成黄昏暖光风格 --resolution 2k
说明：
${buildXaiImageOptionHintText()}
修图命令需要当前消息附图，或引用一条带图消息。若不写 --ratio / --resolution，则优先走当前图像节点的默认值。`;
}

function unquoteCommandOptionValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function sanitizeImageCommandPrompt(rawPrompt) {
  return String(rawPrompt || '')
    .replace(/<quote\b[^>]*\/?>/gi, ' ')
    .replace(/\[CQ:reply,[^\]]+\]/gi, ' ')
    .replace(/\[CQ:image,[^\]]+\]/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<\/img>/gi, ' ')
    .replace(/<image\b[^>]*>/gi, ' ')
    .replace(/<\/image>/gi, ' ')
    .replace(/<at\b[^>]*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeImageCommandOptionValue(key, value) {
  let text = unquoteCommandOptionValue(value).trim();
  text = text.replace(/[，。,；;！!？?]+$/g, '');
  if (key === 'resolution') text = text.toLowerCase();
  return text;
}

function extractTrailingImageCommandOptions(rawPrompt, { allowCount = false } = {}) {
  const allowedKeys = new Set(allowCount
    ? ['count', 'ratio', 'resolution', 'model', 'node']
    : ['ratio', 'resolution', 'model', 'node']);
  const extractedOptions = {};
  const extractedKeys = [];
  let promptText = sanitizeImageCommandPrompt(rawPrompt);

  while (promptText) {
    const match = promptText.match(/(?:^|\s)--(count|ratio|resolution|model|node)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)\s*$/i);
    if (!match) break;
    const key = String(match[1] || '').toLowerCase();
    if (!allowedKeys.has(key)) break;
    extractedOptions[key] = normalizeImageCommandOptionValue(key, match[2]);
    extractedKeys.push(key);
    promptText = promptText.slice(0, match.index).trimEnd();
  }

  return {
    prompt: promptText.trim(),
    options: extractedOptions,
    extractedKeys: extractedKeys.reverse(),
  };
}

function resolveImageCommandPromptAndOptions(rawPrompt, commandOptions, { allowCount = false } = {}) {
  const parsed = extractTrailingImageCommandOptions(rawPrompt, { allowCount });
  const mergedOptions = { ...parsed.options };
  for (const key of ['count', 'ratio', 'resolution', 'model', 'node']) {
    if (commandOptions?.[key] !== undefined && commandOptions?.[key] !== null && commandOptions?.[key] !== '') {
      mergedOptions[key] = normalizeImageCommandOptionValue(key, commandOptions[key]);
    }
  }
  return {
    prompt: parsed.prompt,
    options: mergedOptions,
    extractedKeys: parsed.extractedKeys,
  };
}

function validateXaiImageCommandOptions(options, { allowCount = false } = {}) {
  if (!options || typeof options !== 'object') return null;

  if (allowCount && options.count !== undefined) {
    const count = Number(options.count);
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      return `❌ --count 只能填写 1-10 的整数。\n${buildXaiGenerateUsageText()}`;
    }
  }

  const rawRatio = String(options.ratio || '').trim();
  if (rawRatio) {
    if (rawRatio.includes('：')) {
      return `❌ 宽高比里的冒号请使用英文冒号 ":"，例如 16:9，不要写成 16：9。\n${buildXaiImageOptionHintText()}`;
    }
    if (!XAI_IMAGE_RATIO_OPTIONS.includes(rawRatio)) {
      return `❌ 不支持的宽高比：${rawRatio}\n${buildXaiImageOptionHintText()}\n如果你不想手动指定，请直接省略 --ratio，走当前图像节点的默认比例。`;
    }
  }

  const rawResolution = String(options.resolution || '').trim();
  if (rawResolution) {
    const normalizedResolution = rawResolution.toLowerCase();
    if (!XAI_IMAGE_RESOLUTION_OPTIONS.includes(normalizedResolution)) {
      return `❌ 不支持的分辨率：${rawResolution}\n${buildXaiImageOptionHintText()}\n如果你不想手动指定，请直接省略 --resolution，走当前图像节点的默认清晰度。`;
    }
    options.resolution = normalizedResolution;
  }

  return null;
}

function hasUsableXaiImageNode(apiNode, mode) {
  if (String(apiNode?.providerType || '').toLowerCase() !== 'xai') return false;
  if (!String(apiNode?.apiKey || '').trim()) return false;
  if (mode === 'edit') return !!String(apiNode?.editUrl || '').trim();
  return !!String(apiNode?.generationUrl || '').trim();
}

function resolveXaiImageNode(session, mode, preferredOverride) {
  const preferredIndex = Number.isInteger(preferredOverride) ? preferredOverride : (Number(state.runtimeConfig.activeImageApiIndex) || 0);
  const tried = new Set();
  const candidateIndices = [preferredIndex, ...state.imageApiList.map((_, index) => index)];

  for (const index of candidateIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= state.imageApiList.length) continue;
    if (tried.has(index)) continue;
    tried.add(index);
    const apiNode = state.imageApiList[index];
    if (hasUsableXaiImageNode(apiNode, mode)) {
      return { apiNode, index, preferredIndex, usedFallback: index !== preferredIndex };
    }
  }

  return { apiNode: null, index: -1, preferredIndex, usedFallback: false };
}

async function collectXaiEditImages(ctx, session) {
  const current = await parseMessageContent(ctx, session?.content, session?.elements);
  const currentImages = Array.isArray(current?.images) ? current.images : [];
  const quoted = await extractQuotedContent(ctx, session);
  const quotedImages = Array.isArray(quoted?.images) ? quoted.images : [];

  const merged = [];
  const seen = new Set();
  for (const image of [...currentImages, ...quotedImages]) {
    const url = typeof image?.url === 'string' ? image.url.trim() : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    merged.push({ type: image.type, url });
    if (merged.length >= 5) break;
  }

  return {
    images: merged,
    currentCount: currentImages.length,
    quotedCount: quotedImages.length,
  };
}

async function sendXaiGeneratedImages(session, images, meta = {}) {
  const validImages = Array.isArray(images)
    ? images.filter(image => (image?.type === 'base64' && image?.data) || (image?.type === 'url' && image?.url))
    : [];
  const actionLabel = meta.actionLabel || '图像';
  let sentCount = 0;
  let failedCount = 0;
  let acklessCount = 0;

  for (let index = 0; index < validImages.length; index++) {
    const image = validImages[index];
    const imageLabel = `${actionLabel}第 ${index + 1}/${validImages.length} 张`;
    const sendImage = async () => {
      if (image?.type === 'base64' && image?.data) {
        return session.send(h('image', { src: `base64://${image.data}`, subType: 1, summary: '[AI生成图片]' }));
      }
      return session.send(h('image', { src: image.url, summary: '[AI生成图片]' }));
    };

    if (index > 0) await sleep(650);

    try {
      const ack = await sendImage();
      if (ack === undefined || ack === null || ack === '' || (Array.isArray(ack) && ack.length === 0)) {
        acklessCount++;
        logger.info(`[图像发送] ${imageLabel} 已提交但未返回消息 ID 用户=${session?.userId || '未知'} 场景=${buildImageSceneLabel(session)} 节点=${meta.nodeLabel || '未知节点'} 类型=${image?.type || 'unknown'}`);
      } else {
        logger.info(`[图像发送] ${imageLabel} 已发送 用户=${session?.userId || '未知'} 场景=${buildImageSceneLabel(session)} 节点=${meta.nodeLabel || '未知节点'} 类型=${image?.type || 'unknown'} ack=${stringifySendAck(ack)}`);
      }
      sentCount++;
    } catch (error) {
      logger.warn(`[图像发送] ${imageLabel} 首次发送失败 用户=${session?.userId || '未知'} 场景=${buildImageSceneLabel(session)} 节点=${meta.nodeLabel || '未知节点'} 错误=${error?.message || '未知错误'}，800ms 后重试一次`);
      await sleep(800);
      try {
        const retryAck = await sendImage();
        if (retryAck === undefined || retryAck === null || retryAck === '' || (Array.isArray(retryAck) && retryAck.length === 0)) {
          acklessCount++;
          logger.info(`[图像发送] ${imageLabel} 重试后已提交但未返回消息 ID 用户=${session?.userId || '未知'} 场景=${buildImageSceneLabel(session)} 节点=${meta.nodeLabel || '未知节点'} 类型=${image?.type || 'unknown'}`);
        } else {
          logger.info(`[图像发送] ${imageLabel} 重试后发送成功 用户=${session?.userId || '未知'} 场景=${buildImageSceneLabel(session)} 节点=${meta.nodeLabel || '未知节点'} 类型=${image?.type || 'unknown'} ack=${stringifySendAck(retryAck)}`);
        }
        sentCount++;
      } catch (retryError) {
        failedCount++;
        logger.warn(`[图像发送] ${imageLabel} 重试后仍失败 用户=${session?.userId || '未知'} 场景=${buildImageSceneLabel(session)} 节点=${meta.nodeLabel || '未知节点'} 错误=${retryError?.message || '未知错误'}`);
      }
    }
  }

  return {
    requestedCount: Array.isArray(images) ? images.length : 0,
    validCount: validImages.length,
    sentCount,
    failedCount,
    acklessCount,
  };
}

function clearPendingConversationJobs(session) {
  if (session.isDirect) {
    if (state.privateIntervals[session.userId]) {
      clearTimeout(state.privateIntervals[session.userId]);
      delete state.privateIntervals[session.userId];
    }
    return;
  }

  const prefix = `${session.channelId}_`;
  Object.keys(state.groupMentionBuffers).forEach((key) => {
    if (!key.startsWith(prefix)) return;
    const timer = state.groupMentionBuffers[key]?.timer;
    if (timer) clearTimeout(timer);
    delete state.groupMentionBuffers[key];
  });
}

function forgetCurrentConversation(session) {
  clearPendingConversationJobs(session);

  if (session.isDirect) {
    clearPrivateMemory(session.userId, 'manual-command');
    return "✅ 当前私聊上下文已清除";
  }

  clearGroupMemory(session.channelId, 'manual-command');
  return "✅ 当前群聊上下文已清除";
}

const HELP_MENU_DATA = {
  title: 'NekoAI 指令帮助',
  subtitle: '帮助菜单与人格列表已启用图片卡片渲染；可用 neko.UI 1/2/3 切换风格，渲染失败时自动回退文本。',
  sections: [
    {
      title: '基础管理',
      items: [
        { title: 'neko.重载配置', description: '重载所有 JSON 配置' },
        { title: 'neko.reloadcmd', description: '重载指令避让表' },
        { title: 'forget / neko.forget', description: '清除当前会话记忆（所有人可用）' },
        { title: 'neko.onlymaster', description: '切换仅主人私聊' },
        { title: 'neko.onlyfriends', description: '切换仅群友私聊' },
        { title: 'neko.LM', description: '查看当前上下文堆栈' },
      ],
    },
    {
      title: '动态调参',
      items: [
        { title: 'neko.UI [1/2/3]', description: '切换帮助菜单与人格列表图片风格' },
        { title: 'neko.合并消息 [开/关/自动]' },
        { title: 'neko.表情包概率 【0-1】' },
        { title: 'neko.随机回复概率 【0-1】' },
        { title: 'neko.随机回复检测数 【正整数】' },
        { title: 'neko.合并字数阈值 【正整数】' },
        { title: 'neko.合并段数阈值 【正整数】' },
      ],
    },
    {
      title: '模型管理',
      items: [
        { title: 'neko.模型列表 [页码]', description: '查看所有 API 节点；图片模式下支持分页' },
        { title: 'neko.模型搜索 【关键词】 [页码]', description: '按模型名称检索节点，大小写不敏感，支持文本分页' },
        { title: 'neko.模型列表图片 [开/关]', description: '开关模型列表图片渲染' },
        { title: 'neko.模型切换 【编号】' },
        { title: 'neko.模型添加 【url】 【key】 【model】 [备注]' },
        { title: 'neko.Anthropic格式模型添加 ...' },
        { title: 'neko.Gemini格式模型添加 ...' },
        { title: 'neko.模型列表输出合并 [开/关]' },
      ],
    },
    {
      title: '图像工具',
      items: [
        { title: 'neko.图像模型列表 [页码]', description: '查看独立的图像 API 节点列表' },
        { title: 'neko.图像模型搜索 【关键词】 [页码]', description: '按备注、模型和 URL 搜索图像节点' },
        { title: 'neko.图像模型切换 【编号】', description: '切换当前默认使用的图像节点' },
        { title: 'neko.生图 【提示词】 --ratio 16:9 --resolution 2k', description: 'xAI 生图；比例支持 1:1 / 16:9 / 9:16 等，冒号请用英文 ":"' },
        { title: 'neko.修图 【提示词】 --ratio 1:1 --resolution 1k', description: 'xAI 修图；图片来自当前消息或引用，比例与清晰度不写则走节点默认值' },
        { title: '图像参数提示', description: '预设比例：auto / 1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3 / 2:1 / 1:2 / 19.5:9 / 9:19.5 / 20:9 / 9:20；分辨率：1k / 2k' },
      ],
    },
    {
      title: '人格管理',
      items: [
        { title: 'neko.群聊人格列表 / 添加 / 切换' },
        { title: 'neko.私聊人格列表 / 添加 / 切换' },
        { title: 'neko.群人格绑定 【群号】 【编号】' },
        { title: 'neko.群模型绑定 【群号】 【编号】' },
        { title: 'neko.群绑定列表', description: '查看已绑定群的人格与模型总览（仅主人）' },
      ],
    },
    {
      title: '上下文工具',
      items: [
        { title: 'neko.阅读 [条数]', description: '读取频道消息到上下文' },
        { title: 'neko.读取记录 @用户 【条数】' },
        { title: 'neko.总结记录 @用户 【条数】' },
      ],
    },
    {
      title: '限流 / 黑名单 / 系统',
      items: [
        { title: 'neko.状态面板', description: '查看模型、人格、路由与绑定总览' },
        { title: 'neko.当前群状态', description: '查看本群监听、绑定与限流状态' },
        { title: 'neko.群聊限制 【群号】 【次数】' },
        { title: 'neko.群聊限制查询' },
        { title: 'neko.黑名单添加 @用户' },
        { title: 'neko.黑名单移除 @用户' },
        { title: 'neko.黑名单列表' },
        { title: 'neko.智能路由 [开/关]' },
        { title: 'neko.路由模式 [failover/roundrobin/random]' },
        { title: 'neko.日志级别 【debug/info/warn/error】' },
      ],
    },
  ],
};

function buildHelpMenuFallbackText() {
  return `【NekoAI 指令帮助】
━━ 基础管理 ━━
neko.重载配置 — 重载所有JSON配置
neko.reloadcmd — 重载指令避让表
forget / neko.forget — 清除当前会话记忆（所有人可用）
neko.onlymaster — 切换仅主人私聊
neko.onlyfriends — 切换仅群友私聊
neko.LM — 查看当前上下文堆栈

━━ 动态调参 ━━
neko.UI [1/2/3] — 切换帮助菜单与人格列表图片风格
neko.合并消息 [开/关/自动]
neko.表情包概率 【0-1】
neko.随机回复概率 【0-1】
neko.随机回复检测数 【正整数】
neko.合并字数阈值 【正整数】
neko.合并段数阈值 【正整数】

━━ 模型管理 ━━
neko.模型列表 [页码] — 查看所有API节点
neko.模型搜索 【关键词】 [页码] — 按模型名称检索节点
neko.模型列表图片 [开/关] — 开关模型列表图片渲染
neko.模型切换 【编号】
neko.模型添加 【url】 【key】 【model】 [备注]
neko.Anthropic格式模型添加 ...
neko.Gemini格式模型添加 ...
neko.模型列表输出合并 [开/关]

━━ 图像工具 ━━
neko.图像模型列表 [页码] — 查看独立图像API节点
neko.图像模型搜索 【关键词】 [页码] — 按备注、模型和 URL 搜索图像节点
neko.图像模型切换 【编号】 — 切换默认图像节点
neko.生图 【提示词】 --ratio 16:9 --resolution 2k
neko.画图 【提示词】 — neko.生图 的别名
neko.修图 【提示词】 --ratio 1:1 --resolution 1k
常用比例：auto / 1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3 / 2:1 / 1:2 / 19.5:9 / 9:19.5 / 20:9 / 9:20
常用分辨率：1k / 2k
注意：宽高比里的冒号请用英文冒号 ":"，例如 16:9，不要写成 16：9
如果不写 --ratio / --resolution，则走当前图像节点的默认比例和默认清晰度

━━ 人格管理 ━━
neko.群聊人格列表 / 添加 / 切换
neko.私聊人格列表 / 添加 / 切换
neko.群人格绑定 【群号】 【编号】
neko.群模型绑定 【群号】 【编号】
neko.群绑定列表 — 查看已绑定群的人格与模型总览

━━ 上下文工具 ━━
neko.阅读 [条数] — 读取频道消息到上下文
neko.读取记录 @用户 【条数】
neko.总结记录 @用户 【条数】

━━ 限流管理 ━━
neko.状态面板 — 查看模型、人格、路由与绑定总览
neko.当前群状态 — 查看本群监听、绑定与限流状态
neko.群聊限制 【群号】 【次数】
neko.群聊限制查询

━━ 黑名单 ━━
neko.黑名单添加 @用户
neko.黑名单移除 @用户
neko.黑名单列表

━━ 智能路由 ━━
neko.智能路由 [开/关]
neko.路由模式 [failover/roundrobin/random]

━━ 系统 ━━
neko.日志级别 【debug/info/warn/error】`;
}

function buildUiStyleStatusText() {
  const current = Number(state.runtimeConfig.uiStyle) || 1;
  return `🖼️ 当前图片卡片风格：${current} - ${getUiStyleLabel(current)}
可选风格：
1 - 极光玻璃
2 - 深色终端
3 - 暖纸卡片

影响范围：
- neko
- neko.群聊人格列表
- neko.私聊人格列表

用法：neko.UI 1`;
}

function getCurrentGroupStatusInfo(session) {
  if (!session || session.isDirect) return null;

  const gid = session.channelId;
  const listened = (state.runtimeConfig.groups || []).includes(gid);
  const hasPersonalityBinding = state.runtimeConfig.groupPersonalityMap?.[gid] !== undefined;
  const hasApiBinding = state.runtimeConfig.groupApiMap?.[gid] !== undefined;
  const personalityIndex = getGroupPersonalityIndex(gid);
  const apiIndex = getGroupApiIndex(gid);
  const personality = state.groupPersonalityList[personalityIndex];
  const api = state.apiList[apiIndex];
  const currentPeriod = getPeriodInfo();
  const currentCount = state.usageData.periodId === currentPeriod
    ? (state.usageData.counts[gid] || 0)
    : 0;
  const limit = state.runtimeConfig.groupLimits?.[gid];
  const remaining = limit !== undefined ? Math.max(limit - currentCount, 0) : null;

  return {
    gid,
    listened,
    personalityIndex,
    personality,
    personalitySource: hasPersonalityBinding ? '群独立绑定' : '全局默认',
    apiIndex,
    api,
    apiSource: hasApiBinding ? '群独立绑定' : '全局默认',
    currentPeriod,
    currentCount,
    limit,
    remaining,
  };
}

function buildCurrentGroupStatusPanelData(session) {
  const groupInfo = getCurrentGroupStatusInfo(session);
  if (!groupInfo) return null;

  return {
    title: '当前群状态',
    subtitle: '查看本群当前监听状态、绑定配置与限流使用情况。',
    pills: [
      `群号 ${groupInfo.gid}`,
      groupInfo.listened ? '已在监听列表' : '未加入监听',
      groupInfo.limit !== undefined ? `限流 ${groupInfo.currentCount}/${groupInfo.limit}` : '未设限流',
    ],
    sections: [
      {
        title: '群基础状态',
        itemColumns: 2,
        items: [
          {
            tag: '监听',
            title: groupInfo.listened ? '已启用' : '未启用',
            description: groupInfo.listened ? '本群在允许监听与回复的群列表中' : '本群当前不在 groups 监听列表中',
            highlight: groupInfo.listened,
          },
          {
            tag: '周期',
            title: groupInfo.currentPeriod,
            description: '当前限流统计周期',
          },
        ],
      },
      {
        title: '本群绑定',
        itemColumns: 2,
        items: [
          {
            tag: '人格',
            title: groupInfo.personality?.remark || '未配置',
            description: `#${groupInfo.personalityIndex} · ${groupInfo.personalitySource}`,
          },
          {
            tag: '模型',
            title: groupInfo.api?.remark || '未配置',
            description: groupInfo.api ? `#${groupInfo.apiIndex} · ${(groupInfo.api.aiType || 'openai').toUpperCase()} · ${groupInfo.apiSource}` : '暂无模型',
          },
        ],
      },
      {
        title: '本群限流',
        itemColumns: 2,
        items: [
          {
            tag: '已用次数',
            title: String(groupInfo.currentCount),
            description: '本周期已使用调用次数',
          },
          {
            tag: '限制',
            title: groupInfo.limit !== undefined ? String(groupInfo.limit) : '未设置',
            description: groupInfo.limit !== undefined ? `剩余 ${groupInfo.remaining}` : '本群当前未配置调用上限',
          },
        ],
      },
    ],
  };
}

function buildCurrentGroupStatusFallbackText(session) {
  const groupInfo = getCurrentGroupStatusInfo(session);
  if (!groupInfo) return "❌ 仅限群聊使用。";

  return `【当前群状态】
群号：${groupInfo.gid}
监听状态：${groupInfo.listened ? '已启用' : '未启用'}
当前周期：${groupInfo.currentPeriod}

群聊人格：${groupInfo.personality ? `#${groupInfo.personalityIndex} ${groupInfo.personality.remark}` : '未配置'} (${groupInfo.personalitySource})
当前模型：${groupInfo.api ? `#${groupInfo.apiIndex} ${groupInfo.api.remark} [${groupInfo.api.aiType || 'openai'}] ${groupInfo.api.modelName}` : '未配置'} (${groupInfo.apiSource})

限流状态：${groupInfo.limit !== undefined ? `已设置上限 ${groupInfo.limit}` : '未设置'}
已用次数：${groupInfo.currentCount}
剩余次数：${groupInfo.remaining !== null ? groupInfo.remaining : '无限制'}`;
}

function buildGroupBindingListData() {
  const personalityMap = state.runtimeConfig.groupPersonalityMap || {};
  const apiMap = state.runtimeConfig.groupApiMap || {};
  const personalityItems = Object.entries(personalityMap)
    .map(([gid, index]) => {
      const personality = state.groupPersonalityList[index];
      return {
        tag: gid,
        title: personality?.remark || '人格不存在',
        description: `#${index}`,
      };
    })
    .sort((a, b) => a.tag.localeCompare(b.tag, 'zh-CN'));

  const modelItems = Object.entries(apiMap)
    .map(([gid, index]) => {
      const api = state.apiList[index];
      return {
        tag: gid,
        title: api?.remark || '模型不存在',
        description: api ? `#${index} · ${(api.aiType || 'openai').toUpperCase()} · ${api.modelName}` : `#${index}`,
      };
    })
    .sort((a, b) => a.tag.localeCompare(b.tag, 'zh-CN'));

  return {
    title: '群绑定列表',
    subtitle: '仅展示已配置独立人格或独立模型绑定的群聊。',
    pills: [
      `人格绑定 ${personalityItems.length}`,
      `模型绑定 ${modelItems.length}`,
      `仅主人可见`,
    ],
    sections: [
      {
        title: '人格绑定',
        itemColumns: personalityItems.length > 1 ? 2 : 1,
        items: personalityItems.length ? personalityItems : [{
          tag: '无',
          title: '暂无独立人格绑定',
          description: '当前没有任何群绑定独立人格',
        }],
      },
      {
        title: '模型绑定',
        itemColumns: modelItems.length > 1 ? 2 : 1,
        items: modelItems.length ? modelItems : [{
          tag: '无',
          title: '暂无独立模型绑定',
          description: '当前没有任何群绑定独立模型',
        }],
      },
    ],
  };
}

function buildGroupBindingListFallbackText() {
  const personalityMap = state.runtimeConfig.groupPersonalityMap || {};
  const apiMap = state.runtimeConfig.groupApiMap || {};
  const personalityEntries = Object.entries(personalityMap).sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
  const apiEntries = Object.entries(apiMap).sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));

  let res = '【群绑定列表】';

  res += '\n━━ 人格绑定 ━━';
  if (!personalityEntries.length) {
    res += '\n暂无独立人格绑定';
  } else {
    personalityEntries.forEach(([gid, index]) => {
      const personality = state.groupPersonalityList[index];
      res += `\n群 ${gid} -> [${index}] ${personality?.remark || '人格不存在'}`;
    });
  }

  res += '\n\n━━ 模型绑定 ━━';
  if (!apiEntries.length) {
    res += '\n暂无独立模型绑定';
  } else {
    apiEntries.forEach(([gid, index]) => {
      const api = state.apiList[index];
      const detail = api ? `${api.remark} [${api.aiType || 'openai'}] ${api.modelName}` : '模型不存在';
      res += `\n群 ${gid} -> [${index}] ${detail}`;
    });
  }

  return res;
}

function getModelListImageStatusText(ctx) {
  const enabled = !!state.runtimeConfig.modelListImageEnabled;
  const hasService = !!ctx?.puppeteer?.render;
  return `🖼️ 模型列表图片渲染：${enabled ? '开启' : '关闭'}
当前布局：每页 ${MODEL_LIST_RENDER_PAGE_SIZE} 个节点，5 列高密度排布
Puppeteer 服务：${hasService ? '已检测到' : '未检测到（触发时会回退文本）'}

用法：
- neko.模型列表图片 开
- neko.模型列表图片 关
- neko.模型列表 1`;
}

function getModelListPageData(page) {
  const total = state.apiList.length;
  const totalPages = Math.max(1, Math.ceil(total / MODEL_LIST_RENDER_PAGE_SIZE));
  const finalPage = Math.min(Math.max(page || 1, 1), totalPages);
  const start = (finalPage - 1) * MODEL_LIST_RENDER_PAGE_SIZE;
  const items = state.apiList.slice(start, start + MODEL_LIST_RENDER_PAGE_SIZE);
  return {
    total,
    totalPages,
    page: finalPage,
    start,
    items,
  };
}

function buildModelListFallbackText(page, paged = false) {
  if (!paged) {
    let res = "【API 节点列表】";
    state.apiList.forEach((api, index) => {
      let active = index === state.runtimeConfig.activeApiIndex ? " (当前使用) 👈" : "";
      let typeDisplay = api.aiType ? `[${api.aiType}]` : "[openai]";
      res += `\n[${index}] ${api.remark} ${typeDisplay}${active}\n - 模型: ${api.modelName}`;
    });
    return res;
  }

  const info = getModelListPageData(page);
  let res = `【API 节点列表】第 ${info.page}/${info.totalPages} 页（共 ${info.total} 个）`;
  info.items.forEach((api, idx) => {
    const realIndex = info.start + idx;
    const active = realIndex === state.runtimeConfig.activeApiIndex ? " (当前使用) 👈" : "";
    const typeDisplay = api.aiType ? `[${api.aiType}]` : "[openai]";
    res += `\n[${realIndex}] ${api.remark} ${typeDisplay}${active}\n - 模型: ${api.modelName}`;
  });
  if (info.totalPages > 1) {
    res += `\n\n使用 neko.模型列表 ${Math.min(info.page + 1, info.totalPages)} 查看其它页。`;
  }
  return res;
}

function buildModelSearchResultText(keyword, page) {
  const rawKeyword = String(keyword || '').trim();
  const normalizedKeyword = rawKeyword.toLowerCase();
  if (!normalizedKeyword) {
    return "❌ 用法：neko.模型搜索 【关键词】";
  }

  const results = state.apiList
    .map((api, index) => ({ api, index }))
    .filter(({ api }) => String(api.modelName || '').toLowerCase().includes(normalizedKeyword));

  if (results.length === 0) {
    return `🔍 未找到模型名称包含「${rawKeyword}」的节点。`;
  }

  const totalPages = Math.max(1, Math.ceil(results.length / MODEL_SEARCH_PAGE_SIZE));
  const finalPage = page ? Number(page) : 1;
  if (!Number.isInteger(finalPage) || finalPage < 1 || finalPage > totalPages) {
    return `❌ 页码无效。当前有效范围：1 ~ ${totalPages}`;
  }

  const start = (finalPage - 1) * MODEL_SEARCH_PAGE_SIZE;
  const pageResults = results.slice(start, start + MODEL_SEARCH_PAGE_SIZE);

  let res = `【模型搜索结果】关键词：${rawKeyword}\n命中：${results.length} 个节点\n当前第 ${finalPage}/${totalPages} 页`;
  pageResults.forEach(({ api, index }) => {
    const active = index === state.runtimeConfig.activeApiIndex ? " (当前使用) 👈" : "";
    const typeDisplay = api.aiType ? `[${api.aiType}]` : "[openai]";
    res += `\n[${index}] ${api.remark || '无备注'} ${typeDisplay}${active}\n - 模型: ${api.modelName}`;
  });

  if (totalPages > 1) {
    const nextPage = finalPage < totalPages ? finalPage + 1 : 1;
    res += `\n\n使用 neko.模型搜索 ${rawKeyword} ${nextPage} 查看${finalPage < totalPages ? '下一页' : '第一页'}。`;
  }
  return res;
}

async function tryRenderModelList(ctx, page) {
  const info = getModelListPageData(page);
  const nextHint = info.totalPages > 1
    ? ` 使用 neko.模型列表 ${info.page < info.totalPages ? info.page + 1 : 1} 查看${info.page < info.totalPages ? '下一页' : '第一页'}。`
    : '';
  try {
    return await renderModelListCard(ctx, {
      title: 'API 模型节点一览',
      subtitle: `共 ${info.total} 个节点，当前第 ${info.page}/${info.totalPages} 页。${nextHint}`.trim(),
      pills: [
        `总节点 ${info.total}`,
        `第 ${info.page}/${info.totalPages} 页`,
        `每页 ${MODEL_LIST_RENDER_PAGE_SIZE} 个`,
        `当前 #${state.runtimeConfig.activeApiIndex}`,
      ],
      sectionTitle: '模型节点',
      items: info.items.map((api, idx) => {
        const realIndex = info.start + idx;
        return {
          tag: `#${realIndex}`,
          title: api.remark || '无备注',
          description: `${(api.aiType || 'openai').toUpperCase()} · ${api.modelName}`,
          highlight: realIndex === state.runtimeConfig.activeApiIndex,
        };
      }),
    });
  } catch (e) {
    logger.warn(`模型列表图片渲染失败，回退文本: ${e.message}`);
    return null;
  }
}

function getImageModelListPageData(page) {
  const total = state.imageApiList.length;
  const totalPages = Math.max(1, Math.ceil(total / IMAGE_MODEL_LIST_PAGE_SIZE));
  const finalPage = Math.min(Math.max(page || 1, 1), totalPages);
  const start = (finalPage - 1) * IMAGE_MODEL_LIST_PAGE_SIZE;
  const items = state.imageApiList.slice(start, start + IMAGE_MODEL_LIST_PAGE_SIZE);
  return {
    total,
    totalPages,
    page: finalPage,
    start,
    items,
  };
}

function buildImageModelListFallbackText(page) {
  if (state.imageApiList.length === 0) return "⚠️ 当前没有保存任何图像 API 节点。";
  const info = getImageModelListPageData(page);
  let res = `【图像 API 节点列表】第 ${info.page}/${info.totalPages} 页（共 ${info.total} 个）`;
  info.items.forEach((api, idx) => {
    const realIndex = info.start + idx;
    const active = realIndex === state.runtimeConfig.activeImageApiIndex ? " (当前使用) 👈" : "";
    const provider = String(api.providerType || 'xai').toUpperCase();
    res += `\n[${realIndex}] ${api.remark || '无备注'} [${provider}]${active}\n - 模型: ${api.modelName || 'grok-imagine-image'}`;
  });
  if (info.totalPages > 1) {
    res += `\n\n使用 neko.图像模型列表 ${Math.min(info.page + 1, info.totalPages)} 查看其它页。`;
  }
  return res;
}

function buildImageModelSearchResultText(keyword, page) {
  const rawKeyword = String(keyword || '').trim();
  const normalizedKeyword = rawKeyword.toLowerCase();
  if (!normalizedKeyword) {
    return "❌ 用法：neko.图像模型搜索 【关键词】";
  }

  const results = state.imageApiList
    .map((api, index) => ({ api, index }))
    .filter(({ api }) => {
      const provider = String(api.providerType || 'xai').toLowerCase();
      const modelName = String(api.modelName || '').toLowerCase();
      const remark = String(api.remark || '').toLowerCase();
      const generationUrl = String(api.generationUrl || '').toLowerCase();
      const editUrl = String(api.editUrl || '').toLowerCase();
      return provider.includes(normalizedKeyword)
        || modelName.includes(normalizedKeyword)
        || remark.includes(normalizedKeyword)
        || generationUrl.includes(normalizedKeyword)
        || editUrl.includes(normalizedKeyword);
    });

  if (results.length === 0) {
    return `🔍 未找到匹配「${rawKeyword}」的图像节点。`;
  }

  const totalPages = Math.max(1, Math.ceil(results.length / IMAGE_MODEL_LIST_PAGE_SIZE));
  const finalPage = page ? Number(page) : 1;
  if (!Number.isInteger(finalPage) || finalPage < 1 || finalPage > totalPages) {
    return `❌ 页码无效。当前有效范围：1 ~ ${totalPages}`;
  }

  const start = (finalPage - 1) * IMAGE_MODEL_LIST_PAGE_SIZE;
  const pageResults = results.slice(start, start + IMAGE_MODEL_LIST_PAGE_SIZE);

  let res = `【图像模型搜索结果】关键词：${rawKeyword}\n命中：${results.length} 个节点\n当前第 ${finalPage}/${totalPages} 页`;
  pageResults.forEach(({ api, index }) => {
    const active = index === state.runtimeConfig.activeImageApiIndex ? " (当前使用) 👈" : "";
    const provider = String(api.providerType || 'xai').toUpperCase();
    res += `\n[${index}] ${api.remark || '无备注'} [${provider}]${active}\n - 模型: ${api.modelName || 'grok-imagine-image'}`;
  });

  if (totalPages > 1) {
    const nextPage = finalPage < totalPages ? finalPage + 1 : 1;
    res += `\n\n使用 neko.图像模型搜索 ${rawKeyword} ${nextPage} 查看${finalPage < totalPages ? '下一页' : '第一页'}。`;
  }

  return res;
}

function buildStatusPanelData(session) {
  const activeApi = state.apiList[state.runtimeConfig.activeApiIndex];
  const activeGroupPersonality = state.groupPersonalityList[state.runtimeConfig.activeGroupPersonalityIndex];
  const activePrivatePersonality = state.privatePersonalityList[state.runtimeConfig.activePrivatePersonalityIndex];
  const router = state.runtimeConfig.smartRouter || {};
  const groupInfo = getCurrentGroupStatusInfo(session);
  return {
    title: 'NekoAI 状态面板',
    subtitle: groupInfo
      ? '查看全局模型、人格、路由与当前群上下文概况。'
      : '查看当前模型、人格、渲染风格、智能路由与群绑定概况。',
    pills: [
      `模型 ${state.apiList.length}`,
      `群人格 ${state.groupPersonalityList.length}`,
      `私聊人格 ${state.privatePersonalityList.length}`,
      `UI ${Number(state.runtimeConfig.uiStyle) || 1}`,
      ...(groupInfo ? [`当前群 ${groupInfo.gid}`] : []),
    ],
    sections: [
      ...(groupInfo ? [{
        title: '当前群上下文',
        itemColumns: 2,
        items: [
          {
            tag: '群号',
            title: groupInfo.gid,
            description: groupInfo.listened ? '本群已在监听列表中' : '本群当前未加入监听列表',
            highlight: groupInfo.listened,
          },
          {
            tag: '限流',
            title: groupInfo.limit !== undefined ? `${groupInfo.currentCount}/${groupInfo.limit}` : '未设置',
            description: groupInfo.limit !== undefined ? `剩余 ${groupInfo.remaining}` : '本群当前未配置调用上限',
          },
          {
            tag: '当前群人格',
            title: groupInfo.personality?.remark || '未配置',
            description: `#${groupInfo.personalityIndex} · ${groupInfo.personalitySource}`,
          },
          {
            tag: '当前群模型',
            title: groupInfo.api?.remark || '未配置',
            description: groupInfo.api ? `#${groupInfo.apiIndex} · ${(groupInfo.api.aiType || 'openai').toUpperCase()} · ${groupInfo.apiSource}` : '暂无模型',
          },
        ],
      }] : []),
      {
        title: '当前选择',
        itemColumns: 2,
        items: [
          {
            tag: '模型',
            title: activeApi?.remark || '未配置 API 节点',
            description: activeApi ? `#${state.runtimeConfig.activeApiIndex} · ${(activeApi.aiType || 'openai').toUpperCase()} · ${activeApi.modelName}` : '暂无可用模型',
            highlight: true,
          },
          {
            tag: '群聊人格',
            title: activeGroupPersonality?.remark || '未配置',
            description: `#${state.runtimeConfig.activeGroupPersonalityIndex}`,
          },
          {
            tag: '私聊人格',
            title: activePrivatePersonality?.remark || '未配置',
            description: `#${state.runtimeConfig.activePrivatePersonalityIndex}`,
          },
          {
            tag: '图片风格',
            title: getUiStyleLabel(state.runtimeConfig.uiStyle),
            description: `UI ${Number(state.runtimeConfig.uiStyle) || 1}`,
          },
        ],
      },
      {
        title: '模型与渲染',
        itemColumns: 2,
        items: [
          {
            tag: '模型节点',
            title: `${state.apiList.length} 个`,
            description: `当前活跃索引 #${state.runtimeConfig.activeApiIndex}`,
          },
          {
            tag: '模型列表图片',
            title: state.runtimeConfig.modelListImageEnabled ? '已开启' : '已关闭',
            description: `每页 ${MODEL_LIST_RENDER_PAGE_SIZE} 个，5 列布局`,
          },
          {
            tag: '文本合并',
            title: state.runtimeConfig.forwardModelList ? '已开启' : '已关闭',
            description: '仅在模型列表图片关闭时生效',
          },
          {
            tag: '转发策略',
            title: state.runtimeConfig.forwardStrategy || 'auto',
            description: `字数阈值 ${state.runtimeConfig.forwardMaxLength} / 段数阈值 ${state.runtimeConfig.forwardMaxSegments}`,
          },
        ],
      },
      {
        title: '路由与队列',
        itemColumns: 2,
        items: [
          {
            tag: '智能路由',
            title: router.enabled ? '已开启' : '已关闭',
            description: router.mode ? `模式：${router.mode}` : '未配置',
          },
          {
            tag: '重试参数',
            title: `重试 ${router.retryCount ?? 0} 次`,
            description: `间隔 ${router.retryDelay ?? 0} ms`,
          },
          {
            tag: '请求队列',
            title: `运行中 ${state.queueState.running}`,
            description: `排队 ${state.queueState.queue.length}${(state.runtimeConfig.requestQueue?.maxPending ?? 0) > 0 ? `/${state.runtimeConfig.requestQueue?.maxPending}` : '/∞'} / 并发上限 ${state.runtimeConfig.requestQueue?.maxConcurrent ?? 0}`,
          },
          {
            tag: '日志级别',
            title: state.runtimeConfig.logLevel || 'debug',
            description: `黑名单 ${state.userBlacklist.length} 人`,
          },
        ],
      },
      {
        title: '群与绑定',
        itemColumns: 2,
        items: [
          {
            tag: '监听群',
            title: `${(state.runtimeConfig.groups || []).length} 个`,
            description: '允许响应与记录的群聊数量',
          },
          {
            tag: '人格绑定',
            title: `${Object.keys(state.runtimeConfig.groupPersonalityMap || {}).length} 个群`,
            description: '按群独立人格绑定数量',
          },
          {
            tag: '模型绑定',
            title: `${Object.keys(state.runtimeConfig.groupApiMap || {}).length} 个群`,
            description: '按群独立模型绑定数量',
          },
          {
            tag: '限流项',
            title: `${Object.keys(state.runtimeConfig.groupLimits || {}).length} 个群`,
            description: '配置过 12 小时限制的群数量',
          },
        ],
      },
    ],
  };
}

function buildStatusPanelFallbackText(session) {
  const activeApi = state.apiList[state.runtimeConfig.activeApiIndex];
  const activeGroupPersonality = state.groupPersonalityList[state.runtimeConfig.activeGroupPersonalityIndex];
  const activePrivatePersonality = state.privatePersonalityList[state.runtimeConfig.activePrivatePersonalityIndex];
  const router = state.runtimeConfig.smartRouter || {};
  const groupInfo = getCurrentGroupStatusInfo(session);
  return `【NekoAI 状态面板】
${groupInfo ? `当前群：${groupInfo.gid}
当前群监听：${groupInfo.listened ? '已启用' : '未启用'}
当前群人格：${groupInfo.personality ? `#${groupInfo.personalityIndex} ${groupInfo.personality.remark}` : '未配置'} (${groupInfo.personalitySource})
当前群模型：${groupInfo.api ? `#${groupInfo.apiIndex} ${groupInfo.api.remark} [${groupInfo.api.aiType || 'openai'}] ${groupInfo.api.modelName}` : '未配置'} (${groupInfo.apiSource})
当前群限流：${groupInfo.limit !== undefined ? `${groupInfo.currentCount}/${groupInfo.limit}，剩余 ${groupInfo.remaining}` : '未设置'}

` : ''}当前模型：${activeApi ? `#${state.runtimeConfig.activeApiIndex} ${activeApi.remark} [${activeApi.aiType || 'openai'}] ${activeApi.modelName}` : '未配置'}
群聊人格：${activeGroupPersonality ? `#${state.runtimeConfig.activeGroupPersonalityIndex} ${activeGroupPersonality.remark}` : '未配置'}
私聊人格：${activePrivatePersonality ? `#${state.runtimeConfig.activePrivatePersonalityIndex} ${activePrivatePersonality.remark}` : '未配置'}
图片风格：UI ${Number(state.runtimeConfig.uiStyle) || 1} - ${getUiStyleLabel(state.runtimeConfig.uiStyle)}

模型节点总数：${state.apiList.length}
模型列表图片：${state.runtimeConfig.modelListImageEnabled ? '开启' : '关闭'}
模型列表文本合并：${state.runtimeConfig.forwardModelList ? '开启' : '关闭'}
转发策略：${state.runtimeConfig.forwardStrategy || 'auto'}

智能路由：${router.enabled ? '开启' : '关闭'} (${router.mode || '未配置'})
请求队列：运行中 ${state.queueState.running} / 排队 ${state.queueState.queue.length}${(state.runtimeConfig.requestQueue?.maxPending ?? 0) > 0 ? `/${state.runtimeConfig.requestQueue?.maxPending}` : '/∞'} / 并发上限 ${state.runtimeConfig.requestQueue?.maxConcurrent ?? 0}
日志级别：${state.runtimeConfig.logLevel || 'debug'}
黑名单人数：${state.userBlacklist.length}

监听群：${(state.runtimeConfig.groups || []).length}
人格绑定群：${Object.keys(state.runtimeConfig.groupPersonalityMap || {}).length}
模型绑定群：${Object.keys(state.runtimeConfig.groupApiMap || {}).length}
限流项：${Object.keys(state.runtimeConfig.groupLimits || {}).length}`;
}

async function tryRenderStatusPanel(ctx, session) {
  try {
    return await renderStatusPanelCard(ctx, buildStatusPanelData(session));
  } catch (e) {
    logger.warn(`状态面板图片渲染失败，回退文本: ${e.message}`);
    return null;
  }
}

async function tryRenderCurrentGroupStatus(ctx, session) {
  const data = buildCurrentGroupStatusPanelData(session);
  if (!data) return null;
  try {
    return await renderStatusPanelCard(ctx, data);
  } catch (e) {
    logger.warn(`当前群状态图片渲染失败，回退文本: ${e.message}`);
    return null;
  }
}

async function tryRenderGroupBindingList(ctx) {
  try {
    return await renderStatusPanelCard(ctx, buildGroupBindingListData());
  } catch (e) {
    logger.warn(`群绑定列表图片渲染失败，回退文本: ${e.message}`);
    return null;
  }
}

function buildPersonalityListFallbackText(title, list, activeIndex) {
  let res = `【${title}】`;
  list.forEach((p, index) => {
    let active = index === activeIndex ? ' (当前使用) 👈' : '';
    res += `\n[${index}] ${p.remark}${active}`;
  });
  return res;
}

async function tryRenderHelpMenu(ctx) {
  try {
    return await renderHelpMenuCard(ctx, HELP_MENU_DATA);
  } catch (e) {
    logger.warn(`帮助菜单图片渲染失败，回退文本: ${e.message}`);
    return null;
  }
}

async function tryRenderPersonalityList(ctx, title, sectionTitle, list, activeIndex) {
  try {
    return await renderPersonalityListCard(ctx, {
      title,
      subtitle: '双列卡片展示编号、备注与当前使用状态。',
      sectionTitle,
      items: list.map((item, index) => ({
        tag: `#${index}`,
        title: item.remark,
        highlight: index === activeIndex,
      })),
    });
  } catch (e) {
    logger.warn(`${title} 图片渲染失败，回退文本: ${e.message}`);
    return null;
  }
}

function registerCommands(ctx) {

  // ══════════════════════════════════
  //  主命令 — 帮助菜单 (新增)
  // ══════════════════════════════════
  ctx.command("neko", "NekoAI 指令帮助").action(async ({ session }) => {
    const rendered = await tryRenderHelpMenu(ctx);
    return rendered || buildHelpMenuFallbackText();
  });

  // ══════════════════════════════════
  //  基础管理指令
  // ══════════════════════════════════
  ctx.command("neko.重载配置", "从本地文件重新加载运行时所有设置 (无需重启)").action(async ({ session }) => {
    if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
    loadAllConfigs();
    rescheduleAllMemoryCleanupTimers();
    return "✅ JSON 配置、API节点及人格设定已全面重载！";
  });

  ctx.command("neko.reloadcmd").action(async ({ session }) => {
    if (!isMaster(session)) return "❌ 权限不足。";
    loadCommandsList();
    return "✅ 指令表已重载";
  });

  ctx.command("neko.forget", "清除当前会话记忆（所有人可用）")
    .alias("forget")
    .action(async ({ session }) => {
      return forgetCurrentConversation(session);
    });

  ctx.command("neko.onlymaster").action(async ({ session }) => {
    if (!isMaster(session)) return "❌ 权限不足。";
    state.privateMode = 'master';
    return "✅ 已切换至：仅主人私聊模式";
  });

  ctx.command("neko.onlyfriends").action(async ({ session }) => {
    if (!isMaster(session)) return "❌ 权限不足。";
    state.privateMode = 'friends';
    await updateGroupFriends(ctx);
    return "✅ 已切换至：仅群友私聊模式";
  });

  ctx.command("neko.UI [mode:number]", "切换帮助菜单与人格列表图片风格 (1/2/3)")
    .action(async ({ session }, mode) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (mode === undefined || mode === null || Number.isNaN(mode)) {
        return buildUiStyleStatusText();
      }
      if (![1, 2, 3].includes(mode)) {
        return "❌ 参数错误。用法：neko.UI 1/2/3";
      }
      state.runtimeConfig.uiStyle = mode;
      saveRuntimeConfig();
      return `✅ 已切换图片卡片风格为：${mode} - ${UI_STYLE_LABELS[mode]}\n将影响：neko / neko.群聊人格列表 / neko.私聊人格列表`;
    });

  ctx.command("neko.状态面板", "查看当前模型、人格、路由与绑定总览")
    .action(async ({ session }) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      const rendered = await tryRenderStatusPanel(ctx, session);
      return rendered || buildStatusPanelFallbackText(session);
    });

  ctx.command("neko.当前群状态", "查看本群监听、绑定与限流状态")
    .action(async ({ session }) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (session.isDirect) return "❌ 仅限群聊使用。";
      const rendered = await tryRenderCurrentGroupStatus(ctx, session);
      return rendered || buildCurrentGroupStatusFallbackText(session);
    });

  ctx.command("neko.群绑定列表", "查看已绑定群的人格与模型总览")
    .action(async ({ session }) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      const rendered = await tryRenderGroupBindingList(ctx);
      return rendered || buildGroupBindingListFallbackText();
    });

  // ══════════════════════════════════
  //  群聊限制指令
  // ══════════════════════════════════
  ctx.command("neko.群聊限制 <gid:string> <limit:number>", "设置某个群聊在一个12小时周期内的响应次数上限")
    .action(async ({ session }, gid, limit) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (!gid || limit === undefined) return "❌ 格式不正确。用法：neko.群聊限制 【群号】 【次数】 (输入负数或0可取消限制)";

      if (!state.runtimeConfig.groupLimits) state.runtimeConfig.groupLimits = {};

      if (limit <= 0) {
        delete state.runtimeConfig.groupLimits[gid];
        saveRuntimeConfig();
        return `✅ 已取消群聊 ${gid} 的 AI 调用限制。`;
      } else {
        state.runtimeConfig.groupLimits[gid] = limit;
        saveRuntimeConfig();
        return `✅ 已设置群聊 ${gid} 的调用限制：本次12小时周期内最多 ${limit} 次。跨过 06:00 和 18:00 时自动重置。`;
      }
    });

  ctx.command("neko.群聊限制查询", "查询当前12小时周期内本群聊已经使用的对话次数")
    .action(async ({ session }) => {
      if (session.isDirect) return "❌ 仅限群聊使用。";
      const gid = session.channelId;

      const currentPeriod = getPeriodInfo();
      if (state.usageData.periodId !== currentPeriod) {
        state.usageData.periodId = currentPeriod;
        state.usageData.counts = {};
        saveUsageCounts();
      }

      const currentCount = state.usageData.counts[gid] || 0;
      let limitText = "未设置限制";
      if (state.runtimeConfig.groupLimits && state.runtimeConfig.groupLimits[gid] !== undefined) {
        limitText = `上限 ${state.runtimeConfig.groupLimits[gid]} 次`;
      }

      return `📊 本群聊在当前周期 (${currentPeriod}) 内：\n已使用次数: ${currentCount}\n限制状态: ${limitText}`;
    });

  // ══════════════════════════════════
  //  动态调参指令
  // ══════════════════════════════════
  ctx.command("neko.合并消息 [state:string]", "设置合并转发策略 (开/关/自动)")
    .action(async ({ session }, st) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (st === "开" || st === "开启" || st === "on") {
        state.runtimeConfig.forwardStrategy = "on";
      } else if (st === "关" || st === "关闭" || st === "off") {
        state.runtimeConfig.forwardStrategy = "off";
      } else if (st === "自动" || st === "auto") {
        state.runtimeConfig.forwardStrategy = "auto";
      } else {
        return "❌ 参数错误。用法：neko.合并消息 开/关/自动";
      }
      saveRuntimeConfig();
      return `✅ 已将【消息合并策略】设为: ${state.runtimeConfig.forwardStrategy} (下次回复即生效)`;
    });

  ctx.command("neko.表情包概率 <prob:number>").action(async ({ session }, prob) => {
    if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
    if (prob === undefined || isNaN(prob) || prob < 0 || prob > 1) return "❌ 错误：请输入 0 到 1 之间的数字。";
    state.runtimeConfig.memeProb = parseFloat(prob.toFixed(2));
    saveRuntimeConfig();
    return `✅ 已将【表情包概率】设为: ${state.runtimeConfig.memeProb}`;
  });

  ctx.command("neko.随机回复概率 <prob:number>").action(async ({ session }, prob) => {
    if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
    if (prob === undefined || isNaN(prob) || prob < 0 || prob > 1) return "❌ 错误：请输入 0 到 1 之间的数字。";
    state.runtimeConfig.randomReply = parseFloat(prob.toFixed(2));
    saveRuntimeConfig();
    return `✅ 已将【随机回复概率】设为: ${state.runtimeConfig.randomReply}`;
  });

  ctx.command("neko.随机回复检测数 <count:number>").action(async ({ session }, count) => {
    if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
    if (count === undefined || !Number.isInteger(count) || count < 1) return "❌ 错误：请输入正整数。";
    state.runtimeConfig.messagesLength = count;
    saveRuntimeConfig();
    return `✅ 已将【随机回复检测数】设为: ${state.runtimeConfig.messagesLength} 条`;
  });

  ctx.command("neko.合并字数阈值 <count:number>").action(async ({ session }, count) => {
    if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
    if (count === undefined || !Number.isInteger(count) || count < 1) return "❌ 错误：请输入正整数。";
    state.runtimeConfig.forwardMaxLength = count;
    saveRuntimeConfig();
    return `✅ 已将【合并字数阈值】设为: ${state.runtimeConfig.forwardMaxLength} 字`;
  });

  ctx.command("neko.合并段数阈值 <count:number>").action(async ({ session }, count) => {
    if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
    if (count === undefined || !Number.isInteger(count) || count < 1) return "❌ 错误：请输入正整数。";
    state.runtimeConfig.forwardMaxSegments = count;
    saveRuntimeConfig();
    return `✅ 已将【合并段数阈值】设为: ${state.runtimeConfig.forwardMaxSegments} 段`;
  });

  // ══════════════════════════════════
  //  多节点 API 管理指令
  // ══════════════════════════════════
  ctx.command("neko.模型添加 <url:string> <key:string> <model:string> [remark:text]", "添加新的API节点——本指令默认为openai兼容格式")
    .action(async ({ session }, url, key, model, remark) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (!url || !key || !model) return "❌ 格式不正确。用法：neko.模型添加 【apiUrl】 【apiKey】 【模型名称】 【备注】（本指令默认为openai兼容格式！）";
      state.apiList.push({ apiUrl: url, apiKey: key, modelName: model, remark: remark || "无备注", aiType: "openai" });
      saveApiConfig();
      return `✅ API 节点添加成功！分配编号为：${state.apiList.length - 1}`;
    });

  ctx.command("neko.Anthropic格式模型添加 <url:string> <key:string> <model:string> [remark:text]", "添加Anthropic格式的API节点")
    .action(async ({ session }, url, key, model, remark) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (!url || !key || !model) return "❌ 格式不正确。用法：neko.Anthropic格式模型添加 【apiUrl】 【apiKey】 【模型名称】 【备注】";
      state.apiList.push({ apiUrl: url, apiKey: key, modelName: model, remark: remark || "无备注", aiType: "anthropic" });
      saveApiConfig();
      return `✅ Anthropic格式 API 节点添加成功！分配编号为：${state.apiList.length - 1}`;
    });

  ctx.command("neko.Gemini格式模型添加 <url:string> <key:string> <model:string> [remark:text]", "添加Gemini格式的API节点")
    .action(async ({ session }, url, key, model, remark) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (!url || !key || !model) return "❌ 格式不正确。用法：neko.Gemini格式模型添加 【apiUrl】 【apiKey】 【模型名称】 【备注】";
      state.apiList.push({ apiUrl: url, apiKey: key, modelName: model, remark: remark || "无备注", aiType: "gemini" });
      saveApiConfig();
      return `✅ Gemini格式 API 节点添加成功！分配编号为：${state.apiList.length - 1}`;
    });

  ctx.command("neko.模型列表 [page:number]", "查看所有已保存的API模型节点")
    .action(async ({ session }, page) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (state.apiList.length === 0) return "⚠️ 当前没有保存任何 API 模型节点。";

      if (state.runtimeConfig.modelListImageEnabled) {
        const totalPages = Math.max(1, Math.ceil(state.apiList.length / MODEL_LIST_RENDER_PAGE_SIZE));
        const targetPage = page || 1;
        if (!Number.isInteger(targetPage) || targetPage < 1 || targetPage > totalPages) {
          return `❌ 页码无效。当前有效范围：1 ~ ${totalPages}`;
        }
        const rendered = await tryRenderModelList(ctx, targetPage);
        return rendered || buildModelListFallbackText(targetPage, true);
      }

      if (state.runtimeConfig.forwardModelList) {
        try {
          let forwardNodes = [];
          let chunkCount = 10;
          for (let i = 0; i < state.apiList.length; i += chunkCount) {
            let chunk = state.apiList.slice(i, i + chunkCount);
            let text = `【API 节点列表】 (第 ${Math.floor(i / chunkCount) + 1} 页)`;
            chunk.forEach((api, idx) => {
              let realIndex = i + idx;
              let active = realIndex === state.runtimeConfig.activeApiIndex ? " (当前使用) 👈" : "";
              let typeDisplay = api.aiType ? `[${api.aiType}]` : "[openai]";
              text += `\n[${realIndex}] ${api.remark} ${typeDisplay}${active}\n - 模型: ${api.modelName}`;
            });
            forwardNodes.push(
              h('message',
                h('author', { id: session.bot.selfId, name: state.runtimeConfig.nickName || "Neko" }),
                h.text(text)
              )
            );
          }
          await session.send(h('message', { forward: true }, ...forwardNodes));
          return;
        } catch (e) {
          logger.error(`模型列表合并转发发送失败: ${e.message}`);
        }
      }

      return buildModelListFallbackText();
    });

  ctx.command("neko.模型搜索 <keyword:string> [page:number]", "按模型名称检索节点（不区分大小写，支持文本分页）")
    .action(async ({ session }, keyword, page) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      return buildModelSearchResultText(keyword, page);
    });

  ctx.command("neko.模型列表输出合并 [enable:string]", "设置是否以合并转发形式输出模型列表")
    .action(async ({ session }, enable) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (enable === "true" || enable === "1" || enable === "开启") {
        state.runtimeConfig.forwardModelList = true;
      } else if (enable === "false" || enable === "0" || enable === "关闭") {
        state.runtimeConfig.forwardModelList = false;
      } else {
        state.runtimeConfig.forwardModelList = !state.runtimeConfig.forwardModelList;
      }
      saveRuntimeConfig();
      return `✅ 已将【模型列表输出合并】状态设为: ${state.runtimeConfig.forwardModelList ? "开启 (true)" : "关闭 (false)"}\n说明：仅在【模型列表图片渲染】关闭时生效。`;
    });

  ctx.command("neko.模型列表图片 [enable:string]", "设置模型列表是否使用图片分页渲染")
    .action(async ({ session }, enable) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (enable === undefined || enable === null || enable === '') {
        return getModelListImageStatusText(ctx);
      }
      if (enable === "true" || enable === "1" || enable === "开启" || enable === "开" || enable === "on") {
        state.runtimeConfig.modelListImageEnabled = true;
      } else if (enable === "false" || enable === "0" || enable === "关闭" || enable === "关" || enable === "off") {
        state.runtimeConfig.modelListImageEnabled = false;
      } else {
        return "❌ 参数错误。用法：neko.模型列表图片 开/关";
      }
      saveRuntimeConfig();
      return `✅ 模型列表图片渲染已${state.runtimeConfig.modelListImageEnabled ? '开启' : '关闭'}。\n开启后使用：neko.模型列表 1 / neko.模型列表 2 ...`;
    });

  ctx.command("neko.模型切换 <index:number>", "切换当前使用的API模型节点")
    .action(async ({ session }, index) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (index === undefined || isNaN(index)) return "❌ 请提供节点编号。用法：neko.模型切换 0";
      if (index < 0 || index >= state.apiList.length) return `❌ 编号无效。当前有效范围：0 ~ ${state.apiList.length - 1}`;
      state.runtimeConfig.activeApiIndex = index;
      saveRuntimeConfig();
      const apiNode = state.apiList[index];
      const webSearchNotice = getXaiWebSearchNotice(apiNode);
      return `✅ 已成功切换至节点 [${index}] (${apiNode.remark})\n当前使用模型：${apiNode.modelName}${webSearchNotice ? `\n${webSearchNotice}` : ''}`;
    });

  ctx.command("neko.图像模型列表 [page:number]", "查看所有已保存的图像API节点")
    .action(async ({ session }, page) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      return buildImageModelListFallbackText(page);
    });

  ctx.command("neko.图像模型搜索 <keyword:string> [page:number]", "按备注、模型和 URL 搜索图像节点")
    .action(async ({ session }, keyword, page) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      return buildImageModelSearchResultText(keyword, page);
    });

  ctx.command("neko.图像模型切换 <index:number>", "切换当前使用的图像API节点")
    .action(async ({ session }, index) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (index === undefined || isNaN(index)) return "❌ 请提供节点编号。用法：neko.图像模型切换 0";
      if (index < 0 || index >= state.imageApiList.length) return `❌ 编号无效。当前有效范围：0 ~ ${Math.max(state.imageApiList.length - 1, 0)}`;
      state.runtimeConfig.activeImageApiIndex = index;
      saveRuntimeConfig();
      return `✅ 已成功切换至图像节点 [${index}] (${state.imageApiList[index].remark})\n当前图像模型：${state.imageApiList[index].modelName || 'grok-imagine-image'}`;
    });

  ctx.command("neko.生图 <prompt:text>", "调用 xAI 图像生成接口生成图片")
    .option('count', '--count <count:number>')
    .option('ratio', '--ratio <ratio:string>')
    .option('resolution', '--resolution <resolution:string>')
    .option('model', '--model <model:string>')
    .option('node', '--node <node:number>')
    .alias("neko.画图")
    .action(async ({ session, options }, prompt) => {
      const access = canUseImageCommand(session);
      if (!access.allowed) {
        logger.info(`[图像任务] 生图请求被权限拦截 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 模式=${access.accessMode || 'unknown'} 原因=${access.reason || 'unknown'} 提示词长度=${String(prompt || '').trim().length}`);
        appendUsageEvent(session, {
          category: 'image',
          action: 'generate',
          allowed: false,
          amount: 1,
          reason: access.reason || 'permission-denied',
          isMasterUser: access.isMasterUser === true,
        });
        await sendAutoRecallImageNotice(session, `${access.message}\n${IMAGE_NOTICE_RECALL_HINT}`);
        return;
      }
      const resolvedInput = resolveImageCommandPromptAndOptions(prompt, options, { allowCount: true });
      const cleanPrompt = String(resolvedInput.prompt || '').trim();
      options = resolvedInput.options;
      if (resolvedInput.extractedKeys.length > 0) {
        logger.info(`[图像任务] 生图命令已从提示词尾部补提取参数 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 提取项=${resolvedInput.extractedKeys.join(',')}`);
      }
      if (!cleanPrompt) return buildXaiGenerateUsageText();
      const optionError = validateXaiImageCommandOptions(options, { allowCount: true });
      if (optionError) return optionError;
      const requestedNode = Number.isInteger(Number(options?.node)) ? Number(options.node) : undefined;
      const imageAmount = Number.isInteger(Number(options?.count)) && Number(options.count) > 0 ? Math.min(Number(options.count), 10) : 1;

      const { apiNode, index, usedFallback } = resolveXaiImageNode(session, 'generate', requestedNode);
      if (!apiNode) {
        logger.warn(`[图像任务] 生图请求未找到可用节点 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 提示词预览=${buildImagePromptPreview(cleanPrompt)}`);
        appendUsageEvent(session, {
          category: 'image',
          action: 'generate',
          allowed: false,
          amount: imageAmount,
          reason: 'no-node',
          isMasterUser: access.isMasterUser === true,
        });
        return "❌ 未找到可用的 xAI 图像生成节点。请在 image_api_config.json 或 GUI 的图像节点列表中配置图像生成节点。";
      }

      const nodeLabel = buildImageNodeLabel(apiNode, index);
      logger.info(`[图像任务] 收到生图请求 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 节点=${nodeLabel} fallback=${usedFallback ? '是' : '否'} 提示词长度=${cleanPrompt.length} 提示词预览=${buildImagePromptPreview(cleanPrompt)} 选项=${buildImageOptionSummary(options, { requestedCount: imageAmount })}`);

      const quotaCheck = checkImageQuota(session, 'generate', imageAmount, access.isMasterUser);
      if (!quotaCheck.allowed) {
        logger.info(`[图像任务] 生图额度不足 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 节点=${nodeLabel} 申请=${imageAmount} 已用=${quotaCheck.used} 上限=${quotaCheck.limit} 下次刷新=${quotaCheck.currentPeriod}`);
        appendUsageEvent(session, {
          category: 'image',
          action: 'generate',
          allowed: false,
          amount: imageAmount,
          reason: 'quota-denied',
          isMasterUser: access.isMasterUser === true,
          modelName: apiNode.modelName,
          nodeRemark: apiNode.remark,
          detail: { limit: quotaCheck.limit, used: quotaCheck.used },
        });
        await sendAutoRecallImageNotice(session, `${buildImageQuotaExceededMessage(quotaCheck)}\n${IMAGE_NOTICE_RECALL_HINT}`);
        return;
      }

      await sendAutoRecallImageNotice(session, `🎨 正在生成图片，使用节点 #${index} ${apiNode.remark || apiNode.modelName}。\n请耐心等待1分钟左右。\n${IMAGE_NOTICE_RECALL_HINT}`);
      try {
        const result = await generateXaiImages(ctx, apiNode, cleanPrompt, {
          n: options?.count,
          aspectRatio: options?.ratio,
          resolution: options?.resolution,
          model: options?.model,
        });
        const actualGeneratedCount = Math.max(1, Math.min(imageAmount, Array.isArray(result.images) ? result.images.length : 0));
        const quotaUsage = recordImageQuotaUsage(session, 'generate', actualGeneratedCount, access.isMasterUser, {
          modelName: result.model || apiNode.modelName || 'grok-imagine-image',
          nodeRemark: apiNode.remark || apiNode.modelName,
          detail: { requestedAmount: imageAmount, returnedAmount: Array.isArray(result.images) ? result.images.length : 0 },
        });
        const sendStats = await sendXaiGeneratedImages(session, result.images, { actionLabel: '生图结果', nodeLabel });
        const imageCountNotice = actualGeneratedCount !== imageAmount
          ? `\n⚠️ 本次请求 ${imageAmount} 张，但接口实际返回 ${actualGeneratedCount} 张。`
          : '';
        const sendNotice = sendStats.failedCount > 0
          ? `\n⚠️ 实际发送成功 ${sendStats.sentCount} 张，发送失败 ${sendStats.failedCount} 张。`
          : '';
        logger.info(`[图像任务] 生图完成 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 节点=${nodeLabel} 请求张数=${imageAmount} 返回张数=${Array.isArray(result.images) ? result.images.length : 0} 记账张数=${actualGeneratedCount} 已发送=${sendStats.sentCount} 发送失败=${sendStats.failedCount} 无ACK=${sendStats.acklessCount} 模型=${result.model || apiNode.modelName || 'grok-imagine-image'}`);
        await sendAutoRecallImageNotice(session, `✅ 生图完成：节点 #${index} · ${result.model || apiNode.modelName || 'grok-imagine-image'}${usedFallback ? '（默认图像节点不可用，已自动改用首个可用图像节点）' : ''}${imageCountNotice}${sendNotice}\n${buildImageQuotaUsageNotice({ ...quotaUsage, isMasterUser: access.isMasterUser })}\n${IMAGE_NOTICE_RECALL_HINT}`);
        return;
      } catch (e) {
        logger.warn(`[图像任务] 生图失败 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 节点=${nodeLabel} 提示词长度=${cleanPrompt.length} 提示词预览=${buildImagePromptPreview(cleanPrompt)} 错误=${e.message || '未知错误'}`);
        appendUsageEvent(session, {
          category: 'image',
          action: 'generate',
          allowed: false,
          amount: imageAmount,
          reason: 'request-failed',
          isMasterUser: access.isMasterUser === true,
          modelName: apiNode.modelName,
          nodeRemark: apiNode.remark,
          detail: { error: e.message || '未知错误' },
        });
        await sendAutoRecallImageNotice(session, `❌ 生图失败：${e.message || '未知错误'}\n${IMAGE_NOTICE_RECALL_HINT}`);
        return;
      }
    });

  ctx.command("neko.修图 <prompt:text>", "附带图片或引用带图消息后，调用 xAI 图像编辑接口")
    .option('ratio', '--ratio <ratio:string>')
    .option('resolution', '--resolution <resolution:string>')
    .option('model', '--model <model:string>')
    .option('node', '--node <node:number>')
    .action(async ({ session, options }, prompt) => {
      const access = canUseImageCommand(session);
      if (!access.allowed) {
        logger.info(`[图像任务] 修图请求被权限拦截 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 模式=${access.accessMode || 'unknown'} 原因=${access.reason || 'unknown'} 提示词长度=${String(prompt || '').trim().length}`);
        appendUsageEvent(session, {
          category: 'image',
          action: 'edit',
          allowed: false,
          amount: 1,
          reason: access.reason || 'permission-denied',
          isMasterUser: access.isMasterUser === true,
        });
        await sendAutoRecallImageNotice(session, `${access.message}\n${IMAGE_NOTICE_RECALL_HINT}`);
        return;
      }
      const resolvedInput = resolveImageCommandPromptAndOptions(prompt, options, { allowCount: false });
      const cleanPrompt = String(resolvedInput.prompt || '').trim();
      options = resolvedInput.options;
      if (resolvedInput.extractedKeys.length > 0) {
        logger.info(`[图像任务] 修图命令已从提示词尾部补提取参数 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 提取项=${resolvedInput.extractedKeys.join(',')}`);
      }
      if (!cleanPrompt) return buildXaiEditUsageText();
      const optionError = validateXaiImageCommandOptions(options, { allowCount: false });
      if (optionError) return optionError;

      const imageBundle = await collectXaiEditImages(ctx, session);
      if (imageBundle.images.length === 0) {
        logger.info(`[图像任务] 修图请求未检测到图片 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 提示词预览=${buildImagePromptPreview(cleanPrompt)}`);
        appendUsageEvent(session, {
          category: 'image',
          action: 'edit',
          allowed: false,
          amount: 1,
          reason: 'no-source-image',
          isMasterUser: access.isMasterUser === true,
        });
        await sendAutoRecallImageNotice(session, `❌ 未检测到可用于修图的图片。请在命令消息里附带图片，或引用一条带图消息后再执行。\n${IMAGE_NOTICE_RECALL_HINT}`);
        return;
      }

      const requestedNode = Number.isInteger(Number(options?.node)) ? Number(options.node) : undefined;
      const { apiNode, index, usedFallback } = resolveXaiImageNode(session, 'edit', requestedNode);
      if (!apiNode) {
        logger.warn(`[图像任务] 修图请求未找到可用节点 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 提示词预览=${buildImagePromptPreview(cleanPrompt)} 输入图=${imageBundle.images.length}`);
        appendUsageEvent(session, {
          category: 'image',
          action: 'edit',
          allowed: false,
          amount: 1,
          reason: 'no-node',
          isMasterUser: access.isMasterUser === true,
        });
        return "❌ 未找到可用的 xAI 图像编辑节点。请在 image_api_config.json 或 GUI 的图像节点列表中配置图像编辑节点。";
      }

      const nodeLabel = buildImageNodeLabel(apiNode, index);
      logger.info(`[图像任务] 收到修图请求 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 节点=${nodeLabel} fallback=${usedFallback ? '是' : '否'} 提示词长度=${cleanPrompt.length} 提示词预览=${buildImagePromptPreview(cleanPrompt)} 选项=${buildImageOptionSummary(options, { sourceImageCount: imageBundle.images.length, currentImageCount: imageBundle.currentCount, quotedImageCount: imageBundle.quotedCount })}`);

      const quotaCheck = checkImageQuota(session, 'edit', 1, access.isMasterUser);
      if (!quotaCheck.allowed) {
        logger.info(`[图像任务] 修图额度不足 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 节点=${nodeLabel} 已用=${quotaCheck.used} 上限=${quotaCheck.limit} 下次刷新=${quotaCheck.currentPeriod}`);
        appendUsageEvent(session, {
          category: 'image',
          action: 'edit',
          allowed: false,
          amount: 1,
          reason: 'quota-denied',
          isMasterUser: access.isMasterUser === true,
          modelName: apiNode.modelName,
          nodeRemark: apiNode.remark,
          detail: { limit: quotaCheck.limit, used: quotaCheck.used },
        });
        await sendAutoRecallImageNotice(session, `${buildImageQuotaExceededMessage(quotaCheck)}\n${IMAGE_NOTICE_RECALL_HINT}`);
        return;
      }

      await sendAutoRecallImageNotice(session, `🖌️ 正在修图，使用节点 #${index} ${apiNode.remark || apiNode.modelName}，输入图片 ${imageBundle.images.length} 张。\n请耐心等待1分钟左右。\n${IMAGE_NOTICE_RECALL_HINT}`);
      try {
        const result = await generateXaiImages(ctx, apiNode, cleanPrompt, {
          images: imageBundle.images,
          aspectRatio: options?.ratio,
          resolution: options?.resolution,
          model: options?.model,
        });
        const quotaUsage = recordImageQuotaUsage(session, 'edit', 1, access.isMasterUser, {
          modelName: result.model || apiNode.modelName || 'grok-imagine-image',
          nodeRemark: apiNode.remark || apiNode.modelName,
          detail: { returnedAmount: Array.isArray(result.images) ? result.images.length : 0, sourceImageCount: imageBundle.images.length },
        });
        const sendStats = await sendXaiGeneratedImages(session, result.images, { actionLabel: '修图结果', nodeLabel });
        const imageCountNotice = Array.isArray(result.images) && result.images.length !== 1
          ? `\n⚠️ 接口本次返回 ${result.images.length} 张图。`
          : '';
        const sendNotice = sendStats.failedCount > 0
          ? `\n⚠️ 实际发送成功 ${sendStats.sentCount} 张，发送失败 ${sendStats.failedCount} 张。`
          : '';
        logger.info(`[图像任务] 修图完成 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 节点=${nodeLabel} 返回张数=${Array.isArray(result.images) ? result.images.length : 0} 已发送=${sendStats.sentCount} 发送失败=${sendStats.failedCount} 无ACK=${sendStats.acklessCount} 模型=${result.model || apiNode.modelName || 'grok-imagine-image'}`);
        await sendAutoRecallImageNotice(session, `✅ 修图完成：节点 #${index} · ${result.model || apiNode.modelName || 'grok-imagine-image'}${usedFallback ? '（默认图像节点不可用，已自动改用首个可用图像节点）' : ''}${imageCountNotice}${sendNotice}\n${buildImageQuotaUsageNotice({ ...quotaUsage, isMasterUser: access.isMasterUser })}\n${IMAGE_NOTICE_RECALL_HINT}`);
        return;
      } catch (e) {
        logger.warn(`[图像任务] 修图失败 用户=${session.userId} 场景=${buildImageSceneLabel(session)} 节点=${nodeLabel} 输入图=${imageBundle.images.length} 提示词长度=${cleanPrompt.length} 提示词预览=${buildImagePromptPreview(cleanPrompt)} 错误=${e.message || '未知错误'}`);
        appendUsageEvent(session, {
          category: 'image',
          action: 'edit',
          allowed: false,
          amount: 1,
          reason: 'request-failed',
          isMasterUser: access.isMasterUser === true,
          modelName: apiNode.modelName,
          nodeRemark: apiNode.remark,
          detail: { error: e.message || '未知错误', sourceImageCount: imageBundle.images.length },
        });
        await sendAutoRecallImageNotice(session, `❌ 修图失败：${e.message || '未知错误'}\n${IMAGE_NOTICE_RECALL_HINT}`);
        return;
      }
    });

  // ══════════════════════════════════
  //  人格配置管理指令
  // ══════════════════════════════════

  // 群聊人格
  ctx.command("neko.群聊人格添加 <remark:string> <prompt:text>", "添加新的群聊人格配置")
    .action(async ({ session }, remark, prompt) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (!remark || !prompt) return "❌ 格式不正确。用法：neko.群聊人格添加 【备注】 【提示词】";
      state.groupPersonalityList.push({ remark, prompt });
      saveGroupPersonality();
      return `✅ 群聊人格添加成功！分配编号为：${state.groupPersonalityList.length - 1}`;
    });

  ctx.command("neko.群聊人格列表", "查看所有群聊人格配置")
    .action(async ({ session }) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (state.groupPersonalityList.length === 0) return "⚠️ 当前没有保存任何群聊人格。";
      const rendered = await tryRenderPersonalityList(
        ctx,
        '群聊人格列表',
        '当前可用人格',
        state.groupPersonalityList,
        state.runtimeConfig.activeGroupPersonalityIndex,
      );
      return rendered || buildPersonalityListFallbackText('群聊人格列表', state.groupPersonalityList, state.runtimeConfig.activeGroupPersonalityIndex);
    });

  ctx.command("neko.群聊人格切换 <index:number>", "切换当前使用的群聊人格")
    .action(async ({ session }, index) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (index === undefined || isNaN(index)) return "❌ 请提供编号。用法：neko.群聊人格切换 0";
      if (index < 0 || index >= state.groupPersonalityList.length) return `❌ 编号无效。当前有效范围：0 ~ ${state.groupPersonalityList.length - 1}`;
      state.runtimeConfig.activeGroupPersonalityIndex = index;
      saveRuntimeConfig();
      return `✅ 已成功切换至群聊人格 [${index}] (${state.groupPersonalityList[index].remark})`;
    });

  // 私聊人格
  ctx.command("neko.私聊人格添加 <remark:string> <prompt:text>", "添加新的私聊人格配置")
    .action(async ({ session }, remark, prompt) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (!remark || !prompt) return "❌ 格式不正确。用法：neko.私聊人格添加 【备注】 【提示词】";
      state.privatePersonalityList.push({ remark, prompt });
      savePrivatePersonality();
      return `✅ 私聊人格添加成功！分配编号为：${state.privatePersonalityList.length - 1}`;
    });

  ctx.command("neko.私聊人格列表", "查看所有私聊人格配置")
    .action(async ({ session }) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (state.privatePersonalityList.length === 0) return "⚠️ 当前没有保存任何私聊人格。";
      const rendered = await tryRenderPersonalityList(
        ctx,
        '私聊人格列表',
        '当前可用人格',
        state.privatePersonalityList,
        state.runtimeConfig.activePrivatePersonalityIndex,
      );
      return rendered || buildPersonalityListFallbackText('私聊人格列表', state.privatePersonalityList, state.runtimeConfig.activePrivatePersonalityIndex);
    });

  ctx.command("neko.私聊人格切换 <index:number>", "切换当前使用的私聊人格")
    .action(async ({ session }, index) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (index === undefined || isNaN(index)) return "❌ 请提供编号。用法：neko.私聊人格切换 0";
      if (index < 0 || index >= state.privatePersonalityList.length) return `❌ 编号无效。当前有效范围：0 ~ ${state.privatePersonalityList.length - 1}`;
      state.runtimeConfig.activePrivatePersonalityIndex = index;
      saveRuntimeConfig();
      return `✅ 已成功切换至私聊人格 [${index}] (${state.privatePersonalityList[index].remark})`;
    });

  // ══════════════════════════════════
  //  上下文阅读与总结
  // ══════════════════════════════════
  ctx.command("neko.阅读 [count:number]").action(async ({ session }, count) => {
    count = count || 20;
    try {
      let res = await session.bot.getMessageList(session.channelId);
      let msgs = res.data || res || [];
      if (!Array.isArray(msgs)) return "❌ 无法解析消息列表。";
      msgs = msgs.slice(-(count + 1)).filter(m => m.messageId !== session.messageId);
      let loadedCount = 0;
      let targetArray = session.isDirect ? state.singleMessages[session.userId] : state.historyMessages[session.channelId];
      if (!targetArray) {
        if (session.isDirect) { state.singleMessages[session.userId] = []; targetArray = state.singleMessages[session.userId]; }
        else { state.historyMessages[session.channelId] = []; targetArray = state.historyMessages[session.channelId]; }
      }
      targetArray.length = 0;
      for (const m of msgs) {
        let content = "";
        if (m.elements && m.elements.length > 0) {
          for (const el of m.elements) {
            if (el.type === 'text') content += el.attrs.content;
            else if (el.type === 'img' || el.type === 'image') content += " [图片]";
          }
        } else if (m.content) content = m.content.replace(/<image[^>]*>/g, " [图片]").replace(/<img[^>]*>/g, " [图片]").replace(/<[^>]+>/g, "").trim();
        if (!content) continue;
        let senderName = m.author?.name || m.author?.username || m.author?.nickname || m.userId;
        if (m.userId === session.bot.selfId) senderName = state.runtimeConfig.nickName;
        targetArray.push(SerializeMessage(senderName, content));
        loadedCount++;
      }
      return `✅ 成功载入最近 ${loadedCount} 条消息！`;
    } catch (e) { return `❌ 读取失败: ${e.message}`; }
  });

  ctx.command("neko.读取记录 [args:text]")
    .action(async ({ session }, args) => {
      if (session.isDirect) return "❌ 仅限群聊使用。";
      const atEl = session.elements.find(e => e.type === 'at');
      if (!atEl) return "❌ 请 @ 目标用户！";
      const targetUid = atEl.attrs.id;
      let contentWithoutAt = session.content.replace(/<at[^>]*>/g, "");
      let numMatch = contentWithoutAt.match(/\b\d+\b/);
      if (!numMatch) return "❌ 未识别到数字(拉取条数)。";
      let count = parseInt(numMatch[0], 10);
      if (count < 1 || count > 100) return "❌ 数字必须在 1-100 之间。";

      try {
        let res = await session.bot.getMessageList(session.channelId);
        let msgs = res.data || res || [];
        if (!Array.isArray(msgs)) return "❌ 平台不支持。";
        let userMsgs = msgs.filter(m => String(m.userId || m.author?.userId || m.author?.id) === String(targetUid) && m.messageId !== session.messageId).slice(-count);
        if (userMsgs.length === 0) return `⚠️ 未发现该用户发言。`;

        if (!state.historyMessages[session.channelId]) state.historyMessages[session.channelId] = [];
        let targetArray = state.historyMessages[session.channelId];
        targetArray.length = 0;

        let loadedCount = 0; let targetName = targetUid;
        for (const m of userMsgs) {
          let content = "";
          if (m.elements && m.elements.length > 0) {
            for (const el of m.elements) {
              if (el.type === 'text') content += el.attrs.content;
              else if (el.type === 'img' || el.type === 'image') content += " [图片]";
            }
          } else if (m.content) content = m.content.replace(/<image[^>]*>/g, " [图片]").replace(/<img[^>]*>/g, " [图片]").replace(/<[^>]+>/g, "").trim();
          if (!content) continue;
          targetName = m.author?.name || m.author?.username || m.author?.nickname || m.userId;
          targetArray.push(SerializeMessage(targetName, content));
          loadedCount++;
        }
        return `✅ 记住了 ${targetName} 的 ${loadedCount} 条专属记录。`;
      } catch (e) { return `❌ 失败: ${e.message}`; }
    });

  ctx.command("neko.总结记录 [args:text]")
    .action(async ({ session }, args) => {
      if (session.isDirect) return "❌ 仅限群聊使用。";
      const atEl = session.elements.find(e => e.type === 'at');
      if (!atEl) return "❌ 请 @ 目标用户！";
      const targetUid = atEl.attrs.id;
      let contentWithoutAt = session.content.replace(/<at[^>]*>/g, "");
      let numMatch = contentWithoutAt.match(/\b\d+\b/);
      if (!numMatch) return "❌ 未识别到数字。";
      let count = parseInt(numMatch[0], 10);
      if (count < 1 || count > 100) return "❌ 范围:1-100。";

      await session.send("🔄 Neko 正在总结中，请稍等...");
      try {
        let res = await session.bot.getMessageList(session.channelId);
        let msgs = res.data || res || [];
        if (!Array.isArray(msgs)) return "❌ 平台不支持。";
        let userMsgs = msgs.filter(m => String(m.userId || m.author?.userId || m.author?.id) === String(targetUid) && m.messageId !== session.messageId).slice(-count);
        if (userMsgs.length === 0) return `⚠️ 未发现该用户发言。`;

        let tempHistoryArray = [], loadedCount = 0, targetName = targetUid;
        for (const m of userMsgs) {
          let content = "";
          if (m.elements && m.elements.length > 0) {
            for (const el of m.elements) {
              if (el.type === 'text') content += el.attrs.content;
              else if (el.type === 'img' || el.type === 'image') content += " [图片]";
            }
          } else if (m.content) content = m.content.replace(/<image[^>]*>/g, " [图片]").replace(/<img[^>]*>/g, " [图片]").replace(/<[^>]+>/g, "").trim();
          if (!content) continue;
          targetName = m.author?.name || m.author?.username || m.author?.nickname || m.userId;
          tempHistoryArray.push(SerializeMessage(targetName, content));
          loadedCount++;
        }
        const summaryInstruction = `[系统强制指令] 请结合上述 ${targetName} 最近的 ${loadedCount} 条发言记录，对 ta 所说的内容进行一个精简、客观的总结。概括 ta 在聊些什么。回复语气必须符合你当前的设定。`;
        tempHistoryArray.push(SerializeMessage(session.author?.username || session.userId, summaryInstruction));

        const { getGroupPersonalityIndex } = require('./utils');
        const personalityIdx = getGroupPersonalityIndex(session.channelId);
        let currentPrompt = state.groupPersonalityList[personalityIdx]?.prompt || "你是一个友善的AI";

        const { getAiReply } = require('./api');
        let result = await getAiReply(ctx, tempHistoryArray, currentPrompt, []);
        await sendReply(session, result.reply, result.emoji, state.runtimeConfig.eachLetterCost, state.runtimeConfig.enableMemes, state.runtimeConfig.memesPath);
        return;
      } catch (e) { return `❌ 失败: ${e.message}`; }
    });

  // ══════════════════════════════════
  //  核心堆栈查看 (LM)
  // ══════════════════════════════════
  ctx.command("neko.LM").action(({ session }) => {
    if (!isMaster(session)) return "❌ 无权访问核心堆栈";
    const hist = session.isDirect ? state.singleMessages[session.userId] : state.historyMessages[session.channelId];
    return JSON.stringify(hist || "无记录");
  });

  // ══════════════════════════════════
  //  新增指令 — 黑名单管理
  // ══════════════════════════════════
  ctx.command("neko.黑名单添加 [args:text]", "将@的用户加入黑名单")
    .action(async ({ session }) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      const atEl = session.elements?.find(e => e.type === 'at');
      if (!atEl) return "❌ 请 @ 目标用户！";
      const targetId = atEl.attrs.id;

      if (!state.runtimeConfig.userBlacklist) state.runtimeConfig.userBlacklist = [];
      if (state.runtimeConfig.userBlacklist.includes(targetId)) return `⚠️ 用户 ${targetId} 已在黑名单中。`;

      state.runtimeConfig.userBlacklist.push(targetId);
      state.userBlacklist = state.runtimeConfig.userBlacklist;
      saveRuntimeConfig();
      return `✅ 已将用户 ${targetId} 加入黑名单。`;
    });

  ctx.command("neko.黑名单移除 [args:text]", "将@的用户移出黑名单")
    .action(async ({ session }) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      const atEl = session.elements?.find(e => e.type === 'at');
      if (!atEl) return "❌ 请 @ 目标用户！";
      const targetId = atEl.attrs.id;

      if (!state.runtimeConfig.userBlacklist) state.runtimeConfig.userBlacklist = [];
      const idx = state.runtimeConfig.userBlacklist.indexOf(targetId);
      if (idx === -1) return `⚠️ 用户 ${targetId} 不在黑名单中。`;

      state.runtimeConfig.userBlacklist.splice(idx, 1);
      state.userBlacklist = state.runtimeConfig.userBlacklist;
      saveRuntimeConfig();
      return `✅ 已将用户 ${targetId} 移出黑名单。`;
    });

  ctx.command("neko.黑名单列表", "查看所有黑名单用户")
    .action(async ({ session }) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      const list = state.runtimeConfig.userBlacklist || [];
      if (list.length === 0) return "📋 黑名单为空。";
      let res = "【用户黑名单】";
      list.forEach((uid, i) => { res += `\n[${i}] ${uid}`; });
      return res;
    });

  // ══════════════════════════════════
  //  新增指令 — 按群绑定人格/模型
  // ══════════════════════════════════
  ctx.command("neko.群人格绑定 <gid:string> <index:number>", "为指定群绑定独立人格")
    .action(async ({ session }, gid, index) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (!gid || index === undefined) return "❌ 用法：neko.群人格绑定 【群号】 【人格编号】 (编号为-1取消绑定)";
      if (index === -1) {
        if (!state.runtimeConfig.groupPersonalityMap) state.runtimeConfig.groupPersonalityMap = {};
        delete state.runtimeConfig.groupPersonalityMap[gid];
        saveRuntimeConfig();
        return `✅ 已取消群 ${gid} 的独立人格绑定，将使用全局人格。`;
      }
      if (index < 0 || index >= state.groupPersonalityList.length) return `❌ 编号无效。当前有效范围：0 ~ ${state.groupPersonalityList.length - 1}`;
      if (!state.runtimeConfig.groupPersonalityMap) state.runtimeConfig.groupPersonalityMap = {};
      state.runtimeConfig.groupPersonalityMap[gid] = index;
      saveRuntimeConfig();
      return `✅ 已将群 ${gid} 绑定至人格 [${index}] (${state.groupPersonalityList[index].remark})`;
    });

  ctx.command("neko.群模型绑定 <gid:string> <index:number>", "为指定群绑定独立API模型")
    .action(async ({ session }, gid, index) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (!gid || index === undefined) return "❌ 用法：neko.群模型绑定 【群号】 【API编号】 (编号为-1取消绑定)";
      if (index === -1) {
        if (!state.runtimeConfig.groupApiMap) state.runtimeConfig.groupApiMap = {};
        delete state.runtimeConfig.groupApiMap[gid];
        saveRuntimeConfig();
        return `✅ 已取消群 ${gid} 的独立模型绑定，将使用全局模型。`;
      }
      if (index < 0 || index >= state.apiList.length) return `❌ 编号无效。当前有效范围：0 ~ ${state.apiList.length - 1}`;
      if (!state.runtimeConfig.groupApiMap) state.runtimeConfig.groupApiMap = {};
      state.runtimeConfig.groupApiMap[gid] = index;
      saveRuntimeConfig();
      return `✅ 已将群 ${gid} 绑定至 API 节点 [${index}] (${state.apiList[index].remark})`;
    });

  // ══════════════════════════════════
  //  新增指令 — 智能路由
  // ══════════════════════════════════
  ctx.command("neko.智能路由 [toggle:string]", "开关智能路由")
    .action(async ({ session }, toggle) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      if (!state.runtimeConfig.smartRouter) state.runtimeConfig.smartRouter = { enabled: false, mode: 'failover', retryCount: 2, retryDelay: 1000, excludeIndices: [] };
      if (toggle === "开" || toggle === "开启" || toggle === "on") {
        state.runtimeConfig.smartRouter.enabled = true;
      } else if (toggle === "关" || toggle === "关闭" || toggle === "off") {
        state.runtimeConfig.smartRouter.enabled = false;
      } else {
        state.runtimeConfig.smartRouter.enabled = !state.runtimeConfig.smartRouter.enabled;
      }
      saveRuntimeConfig();
      return `✅ 智能路由已${state.runtimeConfig.smartRouter.enabled ? '开启' : '关闭'} (当前模式: ${state.runtimeConfig.smartRouter.mode})`;
    });

  ctx.command("neko.路由模式 [mode:string]", "设置智能路由策略")
    .action(async ({ session }, mode) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      const validModes = ['failover', 'roundrobin', 'round-robin', 'random'];
      if (!mode || !validModes.includes(mode.toLowerCase())) return `❌ 参数错误。可选值：failover / roundrobin / random`;
      let finalMode = mode.toLowerCase();
      if (finalMode === 'roundrobin') finalMode = 'round-robin';
      if (!state.runtimeConfig.smartRouter) state.runtimeConfig.smartRouter = { enabled: false, mode: 'failover', retryCount: 2, retryDelay: 1000, excludeIndices: [] };
      state.runtimeConfig.smartRouter.mode = finalMode;
      saveRuntimeConfig();
      return `✅ 智能路由策略已设为: ${finalMode}`;
    });

  // ══════════════════════════════════
  //  新增指令 — 日志级别
  // ══════════════════════════════════
  ctx.command("neko.日志级别 <level:string>", "设置日志输出级别")
    .action(async ({ session }, level) => {
      if (!isMaster(session)) return "❌ 权限不足，仅主人可用。";
      const validLevels = ['debug', 'info', 'warn', 'error'];
      if (!level || !validLevels.includes(level.toLowerCase())) return `❌ 参数错误。可选值：debug / info / warn / error`;
      state.runtimeConfig.logLevel = level.toLowerCase();
      saveRuntimeConfig();
      return `✅ 日志级别已设为: ${state.runtimeConfig.logLevel}`;
    });
}

module.exports = { registerCommands };
