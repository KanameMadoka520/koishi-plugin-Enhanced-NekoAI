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
const { appendChatHistory } = require('./history');
const { saveGroupMemory, savePrivateMemory, compressMemoryIfNeeded, loadAllMemory, saveAllMemory } = require('./memory');
const { checkAndUpdateGroupLimit } = require('./ratelimit');
const { loadAllConfigs } = require('./config');

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

      if (state.privateIntervals[uid]) clearTimeout(state.privateIntervals[uid]);
      state.privateIntervals[uid] = setTimeout(async () => {
        let currentPrompt = state.privatePersonalityList[state.runtimeConfig.activePrivatePersonalityIndex]?.prompt || "你是一个友善的AI";
        let result = await getAiReply(ctx, state.singleMessages[uid], currentPrompt, currentImages);

        if (state.singleMessages[uid].length >= state.runtimeConfig.singleMaxMessages) state.singleMessages[uid] = state.singleMessages[uid].slice(-state.runtimeConfig.singleMaxMessages);
        if (result.origin !== "skip") state.singleMessages[uid].push(SerializeMessage(state.runtimeConfig.nickName, result.origin));

        await sendReply(session, result.reply, result.emoji, state.runtimeConfig.eachLetterCost, state.runtimeConfig.enableMemes, state.runtimeConfig.memesPath);

        // 记录聊天历史
        let contextLen = state.singleMessages[uid].slice(0, -1).join("").length;
        let logOrigin = result.origin === "error" ? (result.errorMsg || "未知错误") : result.origin;
        appendChatHistory(session, currentText, contextLen, logOrigin, result.apiInfo, result.origin === "error", result.responseTime);

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

              let result = await getAiReply(ctx, state.historyMessages[gid], currentPrompt, currentImages, apiIdx);
              if (result.origin !== "skip") state.historyMessages[gid].push(SerializeMessage(state.runtimeConfig.nickName, result.origin));
              await sendReply(session, result.reply, result.emoji, state.runtimeConfig.eachLetterCost, state.runtimeConfig.enableMemes, state.runtimeConfig.memesPath);

              // 记录聊天历史
              let contextLen = state.historyMessages[gid].slice(0, -1).join("").length;
              let logOrigin = result.origin === "error" ? (result.errorMsg || "未知错误") : result.origin;
              appendChatHistory(session, currentText, contextLen, logOrigin, result.apiInfo, result.origin === "error", result.responseTime);

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

  // [新增] 回复引用支持
  const quoted = await extractQuotedContent(session);
  if (quoted) {
    state.historyMessages[session.channelId].push(SerializeMessage(quoted.senderName, quoted.text));
  }

  const historyText = currentImages.length > 0 ? `${currentText} [图片]` : currentText;
  state.historyMessages[session.channelId].push(SerializeMessage(session.author?.user?.name || session.author?.name || session.userId, historyText));
  state.messageCount[session.channelId] = 0;

  // [新增] 按群独立人格/模型
  const personalityIdx = getGroupPersonalityIndex(session.channelId);
  let currentPrompt = state.groupPersonalityList[personalityIdx]?.prompt || "你是一个友善的AI";
  const apiIdx = getGroupApiIndex(session.channelId);

  let result = await getAiReply(ctx, state.historyMessages[session.channelId], currentPrompt, currentImages, apiIdx);

  state.singleAsk[session.userId] = false;
  await sendReply(session, result.reply, result.emoji, state.runtimeConfig.eachLetterCost, state.runtimeConfig.enableMemes, state.runtimeConfig.memesPath);
  if (result.origin !== "skip") state.historyMessages[session.channelId].push(SerializeMessage(state.runtimeConfig.nickName, result.origin));

  // 记录聊天历史
  let contextLen = state.historyMessages[session.channelId].slice(0, -1).join("").length;
  let logOrigin = result.origin === "error" ? (result.errorMsg || "未知错误") : result.origin;
  appendChatHistory(session, currentText, contextLen, logOrigin, result.apiInfo, result.origin === "error", result.responseTime);

  // [新增] 保存群聊记忆
  saveGroupMemory(session.channelId);
  compressMemoryIfNeeded(ctx, session.channelId, true);

  await sleep(state.runtimeConfig.singleAskSleep);
  state.singleAsk[session.userId] = true;
}

module.exports = { registerListener };
