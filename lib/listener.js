/**
 * listener.js — 消息事件处理
 * 三个分支：群聊@提及 / 私聊 / 被动潜水话痨
 * 新增：黑名单检查、回复引用、@合并等待、按群独立人格/模型、长期记忆、优雅关闭
 */

const { sleep } = require('koishi');
const state = require('./state');
const logger = require('./logger');
const { isMaster, isBlacklisted, isKoishiCommand, getGroupPersonalityIndex, getGroupApiIndex, safeReplyOrNotify, updateGroupFriends } = require('./utils');
const { parseMessageContent, extractQuotedContent } = require('./parser');
const { sendReply, SerializeMessage } = require('./sender');
const { getAiReply } = require('./api');
const { getQueueSnapshot, buildQueueOverflowText } = require('./queue');
const { appendChatHistory } = require('./history');
const { saveGroupMemory, savePrivateMemory, compressMemoryIfNeeded, saveAllMemory, scheduleGroupMemoryCleanup, schedulePrivateMemoryCleanup } = require('./memory');
const { checkAndUpdateGroupLimit } = require('./ratelimit');
const { loadAllConfigs } = require('./config');

function getProcessingNoticeConfig() {
  const enabled = state.runtimeConfig.sendProcessingNotice !== false;
  const fallbackText = '已接收到请求，请耐心等待处理。不要频繁请求，2分钟内未完成再重试。(本消息30秒后撤回)';
  const text = String(state.runtimeConfig.processingNoticeText || fallbackText).trim() || fallbackText;
  const delay = Number(state.runtimeConfig.processingNoticeDelayMs);
  return {
    enabled,
    text,
    delayMs: Number.isFinite(delay) && delay > 0 ? Math.floor(delay) : 0,
  };
}

function getFailureNoticeConfig() {
  const enabled = state.runtimeConfig.sendFailureNotice !== false;
  const mode = String(state.runtimeConfig.failureNoticeDetailMode || 'full').toLowerCase();
  const detailMode = ['full', 'brief', 'off'].includes(mode) ? mode : 'full';
  const retryText = String(state.runtimeConfig.generationFailedText || '本次生成已失败，请重试。').trim() || '本次生成已失败，请重试。';
  return {
    enabled,
    detailMode,
    retryText,
  };
}

const NOTICE_RECALL_MS = 30000;
const NOTICE_RECALL_HINT = '(本消息30秒后撤回)';
const REPEAT_REQUEST_HINT = '请不要在短时间内重复发送请求。';

function scheduleAutoRecall(session, messageIds, delayMs = NOTICE_RECALL_MS) {
  if (!messageIds) return;
  const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
  if (ids.length === 0) return;
  if (!session?.bot || typeof session.bot.deleteMessage !== 'function') return;
  if (!session.channelId) return;
  setTimeout(async () => {
    for (const id of ids) {
      if (!id) continue;
      try {
        await session.bot.deleteMessage(session.channelId, id);
      } catch (e) {
        logger.debug(`撤回提示失败(${id}): ${e.message}`);
      }
    }
  }, delayMs);
}

function stripRecallHint(text) {
  return String(text || '')
    .replace(/\(本消息30秒后撤回\)/g, '')
    .trim();
}

function formatPendingLimit(snapshot) {
  return snapshot.maxPending > 0 ? String(snapshot.maxPending) : '∞';
}

function buildProcessingNoticeText(snapshot, baseText) {
  const cleanedBaseText = stripRecallHint(baseText) || 'NEKOAI已接收到请求，正在处理中。';
  if (snapshot.willQueue) {
    return `NEKOAI请求并发已满，正在排队处理。\n当前前方有${snapshot.ahead}个请求未完成（运行中 ${snapshot.running}/${snapshot.maxConcurrent}，排队 ${snapshot.pending}/${formatPendingLimit(snapshot)}）。\n${REPEAT_REQUEST_HINT}\n${NOTICE_RECALL_HINT}`;
  }

  const projectedRunning = Math.min(snapshot.running + Math.min(snapshot.availableSlots, snapshot.pending + 1), snapshot.maxConcurrent);
  return `${cleanedBaseText}\n当前并发 ${projectedRunning}/${snapshot.maxConcurrent}，排队 ${snapshot.pending}/${formatPendingLimit(snapshot)}。\n${REPEAT_REQUEST_HINT}\n${NOTICE_RECALL_HINT}`;
}

function buildQueueOverflowNoticeText(snapshot, fallbackText) {
  const mainText = String(fallbackText || buildQueueOverflowText(snapshot)).trim();
  return `${mainText}\n当前前方有${snapshot.ahead}个请求未完成（运行中 ${snapshot.running}/${snapshot.maxConcurrent}，排队 ${snapshot.pending}/${formatPendingLimit(snapshot)}）。\n${REPEAT_REQUEST_HINT}\n${NOTICE_RECALL_HINT}`;
}

async function sendAutoRecallNotice(session, text, delayMs = NOTICE_RECALL_MS) {
  const messageIds = await safeReplyOrNotify(session, text);
  scheduleAutoRecall(session, messageIds, delayMs);
}

function isErrorOrigin(origin) {
  return origin === 'error' || origin === 'queue_overflow';
}

function isSuccessfulAiResult(result) {
  return result.origin !== 'skip' && !isErrorOrigin(result.origin);
}

function createProcessingNoticeTask(session, queueSnapshot) {
  const cfg = getProcessingNoticeConfig();
  let timer = null;
  let sent = false;
  let cancelled = false;

  async function sendNow() {
    if (cancelled || sent || !cfg.enabled) return;
    sent = true;
    try {
      const text = buildProcessingNoticeText(queueSnapshot, cfg.text);
      const messageIds = await safeReplyOrNotify(session, text);
      scheduleAutoRecall(session, messageIds);
    } catch (e) {
      logger.debug(`发送处理中提示失败: ${e.message}`);
    }
  }

  return {
    start(forceImmediate = false) {
      if (!cfg.enabled) return;
      if (forceImmediate || cfg.delayMs <= 0) {
        void sendNow();
        return;
      }
      timer = setTimeout(() => {
        void sendNow();
      }, cfg.delayMs);
    },
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
    wasSent() {
      return sent;
    },
  };
}

function sanitizeErrorForChat(text) {
  return String(text || '未知错误')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function buildGenerationFailedMessage(result) {
  const failureCfg = getFailureNoticeConfig();
  if (!failureCfg.enabled) return '';

  const detail = sanitizeErrorForChat(result?.errorMsg);
  const apiInfo = result?.apiInfo || {};
  const apiLabel = apiInfo.remark && apiInfo.modelName
    ? `节点「${apiInfo.remark} / ${apiInfo.modelName}」`
    : '当前节点';

  if (typeof result?.reply === 'string' && result.reply !== 'skip' && result.reply.trim()) {
    if (failureCfg.detailMode === 'full') {
      return `❌ ${result.reply}\n${failureCfg.retryText}`;
    }
    return `❌ ${failureCfg.retryText}`;
  }

  if (failureCfg.detailMode === 'off') {
    return `❌ ${failureCfg.retryText}`;
  }
  if (failureCfg.detailMode === 'brief') {
    return `❌ ${apiLabel} 请求失败。\n${failureCfg.retryText}`;
  }
  return `❌ ${apiLabel} 请求失败：${detail || '未知错误'}\n${failureCfg.retryText}`;
}

async function sendAiResultToChat(session, result) {
  if (result.origin === 'queue_overflow') {
    await sendAutoRecallNotice(session, buildQueueOverflowNoticeText(result.queueSnapshot || getQueueSnapshot(), result.reply));
    return;
  }

  if (result.origin === 'error') {
    const message = buildGenerationFailedMessage(result);
    if (message) await safeReplyOrNotify(session, message);
    return;
  }

  await sendReply(session, result.reply, result.emoji, state.runtimeConfig.eachLetterCost, state.runtimeConfig.enableMemes, state.runtimeConfig.memesPath);
}

function isGroupMentionFocusEnabled() {
  return state.runtimeConfig.groupMentionFocusMode !== false;
}

function clampGroupHistory(channelId) {
  const limit = Number(state.runtimeConfig.maxGroupMessages);
  const messages = state.historyMessages[channelId];
  if (!Number.isFinite(limit) || limit <= 0 || !Array.isArray(messages) || messages.length <= limit) return;
  state.historyMessages[channelId] = messages.slice(-limit);
}

function buildMentionFocusPrompt(basePrompt) {
  return `${basePrompt}\n\n[系统附加规则：专注@回答模式]\n1. 本次发言是因为群友刚刚@了你，所以“本轮被@消息”才是这次回复的唯一主问题。\n2. 群聊历史、系统摘要、被引用消息都只能作为参考材料，不能抢走主问题。\n3. 除非用户在本轮被@消息里明确要求你“总结/回顾/整理/概括聊天记录”，否则禁止把整段群聊当成总结对象，也禁止主动输出聊天记录总结。\n4. 如果本轮被@消息很短、很模糊，你可以参考引用消息和最近上下文补全语义后直接回答；只有在确实无法判断需求时，才允许简短追问。`;
}

function buildFocusedMentionMessage(currentText, quoted, hasImages) {
  const trimmedText = String(currentText || '').trim();
  const primaryText = trimmedText || (
    hasImages
      ? '（用户本轮@你时没有附带文字，只发送了图片。请优先结合图片内容回答；如果仍无法判断需求，再简短追问。）'
      : '（用户本轮@你时没有附带正文。不要总结整段群聊，请直接简短追问对方想让你做什么。）'
  );

  const parts = [
    '[本轮被@消息｜最高优先级]',
    primaryText,
  ];

  if (quoted) {
    parts.push('[引用消息｜仅供参考]');
    parts.push(`发送者:${quoted.senderName}\n内容:${quoted.text || '[无文本]'}\n附带图片:${quoted.imageCount || 0}张${quoted.imageCount > (quoted.resolvedImageCount || 0) ? `（已解析 ${quoted.resolvedImageCount || 0} 张）` : ''}`);
  }

  parts.push('[回答要求]');
  parts.push('请先回答本轮被@消息本身。除非本轮消息明确要求总结，否则不要总结整段群聊。');
  return parts.join('\n');
}

function registerListener(ctx) {

  // ══════════════════════════════════
  //  消息事件主处理器
  // ══════════════════════════════════
  ctx.on("message", async (session) => {
    // 忽略自身消息
    if (session.userId === session.bot.selfId) return;

    // [新增] 黑名单检查
    if (isBlacklisted(session.userId)) {
      logger.debug(`黑名单用户 ${session.userId}，忽略`);
      return;
    }

    // 全局指令避让
    if (isKoishiCommand(session.content)) {
      logger.debug(`检测到指令避让 (全局): ${session.content.trim()}`);
      return;
    }

    const { text: currentText, images: currentImages } = await parseMessageContent(ctx, session.content, session.elements);

    // ─── 分支1: 群聊 @提及处理 ───
    if ((session.content.includes(state.runtimeConfig.nickName) || session.content.includes(session.bot.selfId)) &&
        session.content.length < 5000 && !session.isDirect) {

      let cleanContent = session.content.split(`<at id="${session.bot.selfId}"/>`).join("").split(state.runtimeConfig.nickName).join("").trim();
      if (isKoishiCommand(cleanContent)) {
        logger.debug(`检测到指令避让 (@处理): ${cleanContent}`);
        return;
      }

      // @合并等待机制
      const groupMentionWait = state.runtimeConfig.groupMentionWait || 0;
      if (groupMentionWait > 0) {
        const bufferKey = `${session.channelId}_${session.userId}`;
        if (!state.groupMentionBuffers[bufferKey]) {
          state.groupMentionBuffers[bufferKey] = { timer: null, texts: [], images: [], session: session };
        }
        const buf = state.groupMentionBuffers[bufferKey];
        buf.texts.push(currentText);
        if (currentImages.length > 0) buf.images.push(...currentImages);
        buf.session = session;

        if (buf.timer) clearTimeout(buf.timer);
        buf.timer = setTimeout(async () => {
          const mergedText = buf.texts.join("\n");
          const mergedImages = buf.images;
          delete state.groupMentionBuffers[bufferKey];
          await handleGroupMention(ctx, buf.session, mergedText, mergedImages);
        }, groupMentionWait);
        return;
      }

      // 无合并等待，直接处理
      await handleGroupMention(ctx, session, currentText, currentImages);
      return;
    }

    // ─── 分支2: 私聊处理 ───
    if (session.isDirect) {
      const uid = session.userId;
      if (!state.runtimeConfig.masterQQ.includes(uid)) {
        let isFriend = false;
        for (const gid of state.runtimeConfig.groups || []) {
          if (state.groupFriendsMap[gid] && state.groupFriendsMap[gid].includes(uid)) { isFriend = true; break; }
        }
      if (state.privateMode === 'master') { await sleep(1000); await safeReplyOrNotify(session, state.runtimeConfig.privateRefuse); return; }
      else if (state.privateMode === 'friends' && !isFriend) { await sleep(1000); await safeReplyOrNotify(session, "拒绝非群友私聊"); return; }
    }

      if (!state.singleMessages[uid]) state.singleMessages[uid] = [];
      const historyText = currentImages.length > 0 ? `${currentText} [图片]` : currentText;
      state.singleMessages[uid].push(SerializeMessage(session.author?.user?.name || session.author?.name || session.userId, historyText));
      schedulePrivateMemoryCleanup(uid);

      if (state.privateIntervals[uid]) clearTimeout(state.privateIntervals[uid]);
      state.privateIntervals[uid] = setTimeout(async () => {
        let currentPrompt = state.privatePersonalityList[state.runtimeConfig.activePrivatePersonalityIndex]?.prompt || "你是一个友善的AI";
        const queueSnapshot = getQueueSnapshot();
        if (queueSnapshot.overflow) {
          await sendAutoRecallNotice(session, buildQueueOverflowNoticeText(queueSnapshot));
          delete state.privateIntervals[uid];
          return;
        }

        const noticeTask = createProcessingNoticeTask(session, queueSnapshot);
        noticeTask.start(queueSnapshot.willQueue);
        let result = await getAiReply(ctx, state.singleMessages[uid], currentPrompt, currentImages);
        noticeTask.cancel();

        if (state.singleMessages[uid].length >= state.runtimeConfig.singleMaxMessages) state.singleMessages[uid] = state.singleMessages[uid].slice(-state.runtimeConfig.singleMaxMessages);
        if (isSuccessfulAiResult(result)) state.singleMessages[uid].push(SerializeMessage(state.runtimeConfig.nickName, result.origin));

        await sendAiResultToChat(session, result);

        // 记录聊天历史
        let contextLen = state.singleMessages[uid].slice(0, -1).join("").length;
        let logOrigin = isErrorOrigin(result.origin) ? (result.errorMsg || "未知错误") : result.origin;
        appendChatHistory(session, currentText, contextLen, logOrigin, result.apiInfo, isErrorOrigin(result.origin), result.responseTime);

        // [新增] 保存私聊记忆
        savePrivateMemory(uid);
        compressMemoryIfNeeded(ctx, uid, false);

        delete state.privateIntervals[uid];
      }, state.runtimeConfig.singleTalkWaiting / 2);
      return;
    }

    // ─── 分支3: 群聊被动潜水/话痨模式 ───
    if (!session.isDirect) {
      const gid = session.channelId;
      if (!state.runtimeConfig.groups || !state.runtimeConfig.groups.includes(gid)) return;

      if (!state.historyMessages[gid]) state.historyMessages[gid] = [];
      if (state.receive[gid] === undefined) state.receive[gid] = true;

      if (state.historyMessages[gid].length >= state.runtimeConfig.maxGroupMessages) state.historyMessages[gid].shift();

      const historyText = currentImages.length > 0 ? `${currentText} [图片]` : currentText;
      state.historyMessages[gid].push(SerializeMessage(session.author?.user?.name || session.author?.name || session.userId, historyText));
      clampGroupHistory(gid);
      scheduleGroupMemoryCleanup(gid);
      state.messageCount[gid]++;

      if (state.messageCount[gid] >= state.runtimeConfig.messagesLength) {
        state.messageCount[gid] = 0;
        if (state.receive[gid] === true) {
          if (Math.random() < state.runtimeConfig.randomReply) {

            // 限流检测（被动插嘴静默拦截）
            let allowProceed = await checkAndUpdateGroupLimit(session, false);
            if (!allowProceed) return;

            state.receive[gid] = false;
            try {
              // [新增] 按群独立人格/模型
              const personalityIdx = getGroupPersonalityIndex(gid);
              let currentPrompt = state.groupPersonalityList[personalityIdx]?.prompt || "你是一个友善的AI";
              const apiIdx = getGroupApiIndex(gid);

              const queueSnapshot = getQueueSnapshot();
              if (queueSnapshot.overflow) {
                logger.info(`[话痨模式] 请求队列已达上限，跳过本次插嘴。运行中 ${queueSnapshot.running}/${queueSnapshot.maxConcurrent}，排队 ${queueSnapshot.pending}/${formatPendingLimit(queueSnapshot)}`);
                return;
              }

              const noticeTask = createProcessingNoticeTask(session, queueSnapshot);
              noticeTask.start(queueSnapshot.willQueue);
              let result = await getAiReply(ctx, state.historyMessages[gid], currentPrompt, currentImages, apiIdx);
              noticeTask.cancel();
              if (isSuccessfulAiResult(result)) {
                state.historyMessages[gid].push(SerializeMessage(state.runtimeConfig.nickName, result.origin));
                clampGroupHistory(gid);
              }
              await sendAiResultToChat(session, result);

              // 记录聊天历史
              let contextLen = state.historyMessages[gid].slice(0, -1).join("").length;
              let logOrigin = isErrorOrigin(result.origin) ? (result.errorMsg || "未知错误") : result.origin;
              appendChatHistory(session, currentText, contextLen, logOrigin, result.apiInfo, isErrorOrigin(result.origin), result.responseTime);

              // [新增] 保存群聊记忆
              saveGroupMemory(gid);
              compressMemoryIfNeeded(ctx, gid, true);

            } catch (e) { logger.error(`话痨模式出错: ${e.message}`); }
            finally { await sleep(state.runtimeConfig.sleepTime); state.receive[gid] = true; }
          }
        }
      }
    }
  });

  // ══════════════════════════════════
  //  启动时加载群友名单
  // ══════════════════════════════════
  ctx.on('ready', async () => {
    await sleep(5000);
    await updateGroupFriends(ctx);
  });

  // ══════════════════════════════════
  //  [新增] 优雅关闭 — 保存所有记忆
  // ══════════════════════════════════
  ctx.on('dispose', () => {
    logger.critical('插件正在关闭，保存所有记忆...');
    saveAllMemory();
    logger.critical('记忆保存完毕，再见！');
  });
}

// ══════════════════════════════════
//  群聊 @提及处理核心逻辑(抽取为独立函数)
// ══════════════════════════════════
async function handleGroupMention(ctx, session, currentText, currentImages) {
  if (!state.singleAsk[session.userId]) state.singleAsk[session.userId] = true;
  if (state.singleAsk[session.userId] === false) return;

  // 限流检测
  let allowProceed = await checkAndUpdateGroupLimit(session, isMaster(session));
  if (!allowProceed) {
    const limitCount = state.runtimeConfig.groupLimits[session.channelId];
    await session.send(`本群聊超出本次12小时周期内${limitCount}次调用限制。`);
    return;
  }

  if (!state.historyMessages[session.channelId]) state.historyMessages[session.channelId] = [];
  const mentionFocusMode = isGroupMentionFocusEnabled();

  // [新增] 回复引用支持
  const quoted = await extractQuotedContent(ctx, session);
  const senderName = session.author?.user?.name || session.author?.name || session.userId;
  const normalizedText = String(currentText || '').trim();
  const historyText = currentImages.length > 0
    ? `${normalizedText || '[仅@提及]'} [图片]`
    : (normalizedText || '[仅@提及]');
  const quotedImages = quoted?.images || [];
  const requestImages = quotedImages.length > 0 ? [...quotedImages, ...currentImages] : currentImages;

  logger.info(`[群聊@] 发送者[${senderName}] 专注模式[${mentionFocusMode ? '开' : '关'}] 当前消息[${normalizedText.length}字] 当前图片[${currentImages.length}张] 引用[${quoted ? '有' : '无'}]${quoted ? ` 引用来源[${quoted.source || 'unknown'}] 引用发送者[${quoted.senderName}] 引用文本[${String(quoted.rawText || '').length}字] 引用图片[${quoted.resolvedImageCount || 0}/${quoted.imageCount || 0}张]` : ''}`);

  let promptHistory = null;

  if (mentionFocusMode) {
    state.historyMessages[session.channelId].push(SerializeMessage(senderName, historyText));
    clampGroupHistory(session.channelId);
    promptHistory = state.historyMessages[session.channelId].slice();
    promptHistory[promptHistory.length - 1] = SerializeMessage(
      senderName,
      buildFocusedMentionMessage(normalizedText, quoted, currentImages.length > 0)
    );
  } else {
    if (quoted) {
      state.historyMessages[session.channelId].push(SerializeMessage(quoted.senderName, quoted.text));
    }
    state.historyMessages[session.channelId].push(SerializeMessage(senderName, historyText));
    clampGroupHistory(session.channelId);
    promptHistory = state.historyMessages[session.channelId];
  }

  scheduleGroupMemoryCleanup(session.channelId);
  state.messageCount[session.channelId] = 0;

  // [新增] 按群独立人格/模型
  const personalityIdx = getGroupPersonalityIndex(session.channelId);
  let currentPrompt = state.groupPersonalityList[personalityIdx]?.prompt || "你是一个友善的AI";
  if (mentionFocusMode) currentPrompt = buildMentionFocusPrompt(currentPrompt);
  const apiIdx = getGroupApiIndex(session.channelId);

  const queueSnapshot = getQueueSnapshot();
  if (queueSnapshot.overflow) {
    await sendAutoRecallNotice(session, buildQueueOverflowNoticeText(queueSnapshot));
    return;
  }

  const noticeTask = createProcessingNoticeTask(session, queueSnapshot);
  noticeTask.start(queueSnapshot.willQueue);
  let result = await getAiReply(ctx, promptHistory, currentPrompt, requestImages, apiIdx);
  noticeTask.cancel();

  state.singleAsk[session.userId] = false;
  await sendAiResultToChat(session, result);
  if (isSuccessfulAiResult(result)) {
    state.historyMessages[session.channelId].push(SerializeMessage(state.runtimeConfig.nickName, result.origin));
    clampGroupHistory(session.channelId);
  }

  // 记录聊天历史
  let contextLen = state.historyMessages[session.channelId].slice(0, -1).join("").length;
  let logOrigin = isErrorOrigin(result.origin) ? (result.errorMsg || "未知错误") : result.origin;
  appendChatHistory(session, currentText, contextLen, logOrigin, result.apiInfo, isErrorOrigin(result.origin), result.responseTime);

  // [新增] 保存群聊记忆
  saveGroupMemory(session.channelId);
  compressMemoryIfNeeded(ctx, session.channelId, true);

  await sleep(state.runtimeConfig.singleAskSleep);
  state.singleAsk[session.userId] = true;
}

module.exports = { registerListener };
