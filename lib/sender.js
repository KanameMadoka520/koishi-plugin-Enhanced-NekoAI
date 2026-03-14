/**
 * sender.js — 消息发送与格式化
 */

const { sleep, h } = require('koishi');
const crypto = require('crypto');
const fs = require('fs');
const state = require('./state');
const logger = require('./logger');

function SerializeMessage(username, content) {
  const { formattedDateTime } = require('./utils');
  return `\n发送时间:${formattedDateTime()}\n发送者:${username}\n发送内容:${content}\n`;
}

function GetEmoji(str) {
  const match = str.match(/\[(.*?)\]/);
  return match ? match[1] : null;
}

function formatForQQ(text) {
  if (!text) return "";
  return text
    .replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, '\n$1\n')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^(#{1,6})\s+(.*)/gm, '【$2】')
    .replace(/^>\s*(.*)/gm, '「$1」')
    .replace(/^([ \t]*)[\*\-]\s+/gm, '$1• ')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendReply(session, text, emoji, eachLetterCost, enableMemes, memesPath) {
  if (text === "skip") return;
  if (!Array.isArray(text)) text = [text];

  let validText = text.filter(t => t);
  if (validText.length === 0) return;

  let totalLength = validText.join("").length;
  let thresholdSegments = state.runtimeConfig.forwardMaxSegments || 5;
  let thresholdLength = state.runtimeConfig.forwardMaxLength || 300;

  let useForward = false;
  if (state.runtimeConfig.forwardStrategy === "on") {
    useForward = true;
  } else if (state.runtimeConfig.forwardStrategy === "off") {
    useForward = false;
  } else {
    useForward = (validText.length >= thresholdSegments) || (totalLength >= thresholdLength);
  }

  logger.info(`发送回复: ${totalLength}字 ${validText.length}段 合并转发:${useForward ? '是' : '否'} (策略:${state.runtimeConfig.forwardStrategy || 'auto'})`);

  let forwardSuccess = false;

  if (useForward) {
    try {
      const forwardNodes = validText.map(msg => {
        return h('message',
          h('author', { id: session.bot.selfId, name: state.runtimeConfig.nickName || "Neko" }),
          h.text(msg.replace('""', ""))
        );
      });
      const msgIds = await session.send(h('message', { forward: true }, ...forwardNodes));
      if (!msgIds || msgIds.length === 0) {
        logger.warn("触发 Fallback：合并转发返回为空(风控拦截)，降级为逐段发送");
        forwardSuccess = false;
      } else {
        forwardSuccess = true;
      }
    } catch (e) {
      logger.warn(`合并转发失败 (${e.message})，降级为逐段发送`);
      forwardSuccess = false;
    }
  }

  if (!useForward || !forwardSuccess) {
    for (let i = 0; i < text.length; i++) {
      if (!text[i]) continue;
      let waitTime = eachLetterCost * text[i].length + crypto.randomInt(0, 500);
      await sleep(waitTime);
      try {
        await session.send(h.text(text[i].replace('""', "")));
      } catch (e) { logger.error(`消息发送失败: ${e.message}`); }
    }
  }

  // 表情包发送
  if (emoji != null && emoji !== "skip") {
    if (!state.memes[emoji]) emoji = "万用";
    await sleep(500);
    let currentMemeProb = state.runtimeConfig.memeProb !== undefined ? state.runtimeConfig.memeProb : 1;
    if (enableMemes && memesPath && state.memes[emoji] && state.memes[emoji].length > 0 && Math.random() < currentMemeProb) {
      const randomImgPath = state.memes[emoji][crypto.randomInt(0, state.memes[emoji].length)];
      try {
        const imageBuffer = fs.readFileSync(randomImgPath);
        await session.send(h('image', { src: `base64://${imageBuffer.toString('base64')}`, subType: 1, summary: '[表情]' }));
      } catch (e) { logger.debug(`表情包发送失败: ${e.message}`); }
    }
  }
}

module.exports = { SerializeMessage, GetEmoji, formatForQQ, sendReply };
