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
  saveAllMemory, loadAllMemory, compressMemoryIfNeeded
};
