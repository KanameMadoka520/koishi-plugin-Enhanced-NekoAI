/**
 * history.js — 聊天历史记录持久化
 * 按 Day/Night 周期滚动写入 chat-history/ 目录
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { formattedDateTime, getPeriodInfo } = require('./utils');

const BASE_DIR = path.join(__dirname, '..');

function appendChatHistory(session, promptText, contextLen, replyText, apiInfo, isError, responseTime) {
  try {
    const historyDir = path.join(BASE_DIR, 'chat-history');
    const periodId = getPeriodInfo();
    const fileName = `history_${periodId}.json`;
    const filePath = path.join(historyDir, fileName);

    let logs = [];
    if (fs.existsSync(filePath)) {
      try { logs = JSON.parse(fs.readFileSync(filePath, "utf-8")); }
      catch (e) { logs = []; }
    }

    const isGroup = !session.isDirect;
    const logEntry = {
      timestamp: formattedDateTime(),
      type: isGroup ? 'group' : 'private',
      channelId: isGroup ? session.channelId : null,
      userId: session.userId,
      username: session.author?.name || session.author?.username || session.author?.nickname || session.userId,
      prompt: promptText,
      reply: replyText,
      isError: isError,
      promptLength: promptText ? promptText.length : 0,
      replyLength: isError ? 0 : (replyText ? replyText.length : 0),
      contextLength: contextLen || 0,
      modelName: apiInfo?.modelName || "unknown",
      apiRemark: apiInfo?.remark || "unknown",
      responseTime: responseTime || 0  // [新增] API 响应耗时(ms)
    };

    logs.push(logEntry);
    fs.writeFileSync(filePath, JSON.stringify(logs, null, 2), "utf-8");
    logger.debug(`历史记录已写入 ${fileName} (响应耗时 ${responseTime}ms)`);
  } catch (e) {
    logger.error(`写入聊天历史记录失败: ${e.message}`);
  }
}

module.exports = { appendChatHistory };
