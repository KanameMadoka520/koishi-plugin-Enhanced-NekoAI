/**
 * memory.js — 长期记忆持久化系统
 * - 每个群/每个私聊用户的上下文独立存储在 memory/ 目录下
 * - 支持启动时恢复、每次回复后保存、优雅关闭时全量保存
 * - 支持记忆摘要压缩（超过阈值时调用 AI 总结旧消息）
 */

const fs = require('fs');
const path = require('path');
const state = require('./state');
const logger = require('./logger');

const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const GROUP_DIR = path.join(MEMORY_DIR, 'group');
const PRIVATE_DIR = path.join(MEMORY_DIR, 'private');

function getAutoForgetMs() {
  const value = Number(state.runtimeConfig.contextAutoForgetMs);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function clearMemoryTimer(timerBucket, key) {
  if (!timerBucket[key]) return;
  clearTimeout(timerBucket[key]);
  delete timerBucket[key];
}

function clearMemoryActivity(activityBucket, key) {
  if (!activityBucket[key]) return;
  delete activityBucket[key];
}

function getRemainingTtl(lastActivityAt, ttl) {
  if (!lastActivityAt) return 0;
  const elapsed = Math.max(0, Date.now() - lastActivityAt);
  return Math.max(1, ttl - elapsed);
}

function persistEmptyMemory(filePath, label) {
  try {
    fs.writeFileSync(filePath, '[]', 'utf-8');
    logger.debug(`${label} 已写回空记忆文件`);
  } catch (e) {
    logger.error(`清空${label}记忆文件失败: ${e.message}`);
  }
}

// --- 单个保存/加载 ---

function saveGroupMemory(channelId) {
  try {
    const data = state.historyMessages[channelId] || [];
    const filePath = path.join(GROUP_DIR, `${channelId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
    logger.debug(`群 ${channelId} 记忆已保存 (${data.length} 条)`);
  } catch (e) { logger.error(`保存群记忆失败 [${channelId}]: ${e.message}`); }
}

function loadGroupMemory(channelId) {
  try {
    const filePath = path.join(GROUP_DIR, `${channelId}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (Array.isArray(data) && data.length > 0) {
        state.historyMessages[channelId] = data;
        logger.debug(`群 ${channelId} 记忆已恢复 (${data.length} 条)`);
        return true;
      }
    }
  } catch (e) { logger.debug(`加载群记忆失败 [${channelId}]: ${e.message}`); }
  return false;
}

function savePrivateMemory(userId) {
  try {
    const data = state.singleMessages[userId] || [];
    const filePath = path.join(PRIVATE_DIR, `${userId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
    logger.debug(`私聊 ${userId} 记忆已保存 (${data.length} 条)`);
  } catch (e) { logger.error(`保存私聊记忆失败 [${userId}]: ${e.message}`); }
}

function loadPrivateMemory(userId) {
  try {
    const filePath = path.join(PRIVATE_DIR, `${userId}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (Array.isArray(data) && data.length > 0) {
        state.singleMessages[userId] = data;
        logger.debug(`私聊 ${userId} 记忆已恢复 (${data.length} 条)`);
        return true;
      }
    }
  } catch (e) { logger.debug(`加载私聊记忆失败 [${userId}]: ${e.message}`); }
  return false;
}

function clearGroupMemory(channelId, reason = 'manual') {
  clearMemoryTimer(state.groupMemoryTimers, channelId);
  clearMemoryActivity(state.groupMemoryActivityAt, channelId);
  state.historyMessages[channelId] = [];
  state.messageCount[channelId] = 0;
  persistEmptyMemory(path.join(GROUP_DIR, `${channelId}.json`), `群 ${channelId}`);
  logger.info(`群 ${channelId} 上下文已清空 (原因: ${reason})`);
}

function clearPrivateMemory(userId, reason = 'manual') {
  clearMemoryTimer(state.privateMemoryTimers, userId);
  clearMemoryActivity(state.privateMemoryActivityAt, userId);
  state.singleMessages[userId] = [];
  persistEmptyMemory(path.join(PRIVATE_DIR, `${userId}.json`), `私聊 ${userId}`);
  logger.info(`私聊 ${userId} 上下文已清空 (原因: ${reason})`);
}

function scheduleGroupMemoryCleanup(channelId, options = {}) {
  clearMemoryTimer(state.groupMemoryTimers, channelId);

  const ttl = getAutoForgetMs();
  const messages = state.historyMessages[channelId];
  if (ttl <= 0 || !Array.isArray(messages) || messages.length === 0) {
    clearMemoryActivity(state.groupMemoryActivityAt, channelId);
    return;
  }

  if (options.touch !== false) {
    state.groupMemoryActivityAt[channelId] = Date.now();
  }

  const lastActivityAt = state.groupMemoryActivityAt[channelId];
  if (!lastActivityAt) return;

  const waitMs = getRemainingTtl(lastActivityAt, ttl);

  state.groupMemoryTimers[channelId] = setTimeout(() => {
    clearGroupMemory(channelId, `idle>${ttl}ms`);
  }, waitMs);
  logger.debug(`群 ${channelId} 已${options.touch === false ? '恢复' : '启动/重置'}自动清空计时器 (${waitMs}ms, TTL=${ttl}ms)`);
}

function schedulePrivateMemoryCleanup(userId, options = {}) {
  clearMemoryTimer(state.privateMemoryTimers, userId);

  const ttl = getAutoForgetMs();
  const messages = state.singleMessages[userId];
  if (ttl <= 0 || !Array.isArray(messages) || messages.length === 0) {
    clearMemoryActivity(state.privateMemoryActivityAt, userId);
    return;
  }

  if (options.touch !== false) {
    state.privateMemoryActivityAt[userId] = Date.now();
  }

  const lastActivityAt = state.privateMemoryActivityAt[userId];
  if (!lastActivityAt) return;

  const waitMs = getRemainingTtl(lastActivityAt, ttl);

  state.privateMemoryTimers[userId] = setTimeout(() => {
    clearPrivateMemory(userId, `idle>${ttl}ms`);
  }, waitMs);
  logger.debug(`私聊 ${userId} 已${options.touch === false ? '恢复' : '启动/重置'}自动清空计时器 (${waitMs}ms, TTL=${ttl}ms)`);
}

function rescheduleAllMemoryCleanupTimers() {
  Object.keys(state.groupMemoryTimers).forEach((channelId) => clearMemoryTimer(state.groupMemoryTimers, channelId));
  Object.keys(state.privateMemoryTimers).forEach((userId) => clearMemoryTimer(state.privateMemoryTimers, userId));

  const ttl = getAutoForgetMs();
  if (ttl <= 0) {
    logger.info('上下文自动清空已关闭');
    return;
  }

  let activeGroupCount = 0;
  let activePrivateCount = 0;

  Object.keys(state.groupMemoryActivityAt).forEach((channelId) => {
    if (Array.isArray(state.historyMessages[channelId]) && state.historyMessages[channelId].length > 0) {
      scheduleGroupMemoryCleanup(channelId, { touch: false });
      activeGroupCount++;
    } else {
      clearMemoryActivity(state.groupMemoryActivityAt, channelId);
    }
  });

  Object.keys(state.privateMemoryActivityAt).forEach((userId) => {
    if (Array.isArray(state.singleMessages[userId]) && state.singleMessages[userId].length > 0) {
      schedulePrivateMemoryCleanup(userId, { touch: false });
      activePrivateCount++;
    } else {
      clearMemoryActivity(state.privateMemoryActivityAt, userId);
    }
  });

  if (activeGroupCount === 0 && activePrivateCount === 0) {
    logger.info(`上下文自动清空计时器已重载；当前无活跃会话，后续仅在收到新上下文后启动 (TTL=${ttl}ms)`);
    return;
  }

  logger.info(`上下文自动清空计时器已重载 (活跃群聊 ${activeGroupCount} 个, 活跃私聊 ${activePrivateCount} 个, TTL=${ttl}ms)`);
}

// --- 全量操作 ---

function saveAllMemory() {
  let groupCount = 0, privateCount = 0;
  for (const channelId in state.historyMessages) {
    if (state.historyMessages[channelId] && state.historyMessages[channelId].length > 0) {
      saveGroupMemory(channelId);
      groupCount++;
    }
  }
  for (const userId in state.singleMessages) {
    if (state.singleMessages[userId] && state.singleMessages[userId].length > 0) {
      savePrivateMemory(userId);
      privateCount++;
    }
  }
  logger.info(`全量记忆保存完毕 (${groupCount} 个群聊, ${privateCount} 个私聊)`);
}

function loadAllMemory() {
  let groupCount = 0, privateCount = 0;

  // 加载群聊记忆
  try {
    if (fs.existsSync(GROUP_DIR)) {
      const files = fs.readdirSync(GROUP_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const channelId = file.replace('.json', '');
        if (loadGroupMemory(channelId)) groupCount++;
      }
    }
  } catch (e) { logger.error(`扫描群聊记忆目录失败: ${e.message}`); }

  // 加载私聊记忆
  try {
    if (fs.existsSync(PRIVATE_DIR)) {
      const files = fs.readdirSync(PRIVATE_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const userId = file.replace('.json', '');
        if (loadPrivateMemory(userId)) privateCount++;
      }
    }
  } catch (e) { logger.error(`扫描私聊记忆目录失败: ${e.message}`); }

  logger.info(`长期记忆加载完毕 (${groupCount} 个群聊, ${privateCount} 个私聊)`);
}

/**
 * 记忆摘要压缩
 * 当上下文超过阈值时，调用 AI 对旧消息做一次总结，用摘要替代原始消息
 * @param {object} ctx - Koishi context
 * @param {string} key - channelId 或 userId
 * @param {boolean} isGroup - 是否为群聊
 */
async function compressMemoryIfNeeded(ctx, key, isGroup) {
  const cfg = state.runtimeConfig.memorySummary || {};
  if (!cfg.enabled) return;

  const threshold = cfg.threshold || 30;
  const messages = isGroup ? state.historyMessages[key] : state.singleMessages[key];
  if (!messages || messages.length < threshold) return;

  logger.info(`[记忆压缩] ${isGroup ? '群' : '私聊'} ${key} 上下文达 ${messages.length} 条，开始摘要压缩...`);

  try {
    // 取前 70% 的消息做摘要，保留最近 30%
    const splitPoint = Math.floor(messages.length * 0.7);
    const oldMessages = messages.slice(0, splitPoint);
    const recentMessages = messages.slice(splitPoint);

    const summaryPrompt = cfg.summaryPrompt || "请用不超过200字的中文总结以下对话中的关键信息：";
    const oldText = oldMessages.join("\n");

    // 使用当前 API 节点调用摘要
    const { getAiReply } = require('./api');
    const result = await getAiReply(ctx, [oldText, summaryPrompt], "你是一个精准的对话摘要助手，只输出摘要内容。", []);

    if (result.origin && result.origin !== "error" && result.origin !== "skip") {
      const { SerializeMessage } = require('./sender');
      const summaryMsg = SerializeMessage("系统摘要", `[历史上下文摘要] ${result.origin}`);
      const newMessages = [summaryMsg, ...recentMessages];

      if (isGroup) { state.historyMessages[key] = newMessages; saveGroupMemory(key); }
      else { state.singleMessages[key] = newMessages; savePrivateMemory(key); }

      logger.info(`[记忆压缩] 完成：${messages.length} 条 → ${newMessages.length} 条 (摘要 ${result.origin.length} 字)`);
    } else {
      logger.warn(`[记忆压缩] AI 摘要调用失败，跳过压缩`);
    }
  } catch (e) {
    logger.error(`[记忆压缩] 异常: ${e.message}`);
  }
}

module.exports = {
  saveGroupMemory, loadGroupMemory, savePrivateMemory, loadPrivateMemory,
  saveAllMemory, loadAllMemory, clearGroupMemory, clearPrivateMemory,
  scheduleGroupMemoryCleanup, schedulePrivateMemoryCleanup,
  rescheduleAllMemoryCleanupTimers, compressMemoryIfNeeded
};
