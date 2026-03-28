/**
 * parser.js — 消息内容解析
 * 包含：文本/图片提取、图片下载、回复引用提取
 */

const logger = require('./logger');

async function downloadImageAsBase64(ctx, url) {
  try {
    const buffer = await ctx.http.get(url, { responseType: 'arraybuffer' });
    const sizeInMB = buffer.length / (1024 * 1024);
    if (sizeInMB > 6) {
      logger.debug(`图片过大 (${sizeInMB.toFixed(2)}MB)，已忽略`);
      return null;
    }
    return `data:image/jpeg;base64,${Buffer.from(buffer).toString('base64')}`;
  } catch (e) { return null; }
}

async function parseMessageContent(ctx, content, elements) {
  let textContent = "", imageUrls = [], externalImageUrls = [];

  if (elements && elements.length > 0) {
    for (const el of elements) {
      if (el.type === 'text') textContent += el.attrs.content;
      else if (el.type === 'img' || el.type === 'image') if (el.attrs.src) imageUrls.push(el.attrs.src);
    }
  } else {
    const imgRegex = /src="([^"]*)"/g; let match;
    while ((match = imgRegex.exec(content)) !== null) imageUrls.push(match[1]);
    textContent = content.replace(/<[^>]+>/g, "").trim();
  }

  // 从纯文本中提取外部图片链接
  const urlRegex = /(https?:\/\/[^\s]+?\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s]*)?)/gi;
  let textMatch;
  while ((textMatch = urlRegex.exec(textContent)) !== null) {
    externalImageUrls.push(textMatch[1]);
  }
  textContent = textContent.replace(urlRegex, " [外部图片链接] ").trim();

  let finalImages = [];
  for (const url of imageUrls) {
    const b64 = await downloadImageAsBase64(ctx, url);
    if (b64) finalImages.push({ type: 'base64', url: b64 });
  }
  for (const url of externalImageUrls) {
    finalImages.push({ type: 'url', url: url });
  }

  return { text: textContent, images: finalImages };
}

function buildQuotedTextSummary(text, imageCount) {
  const trimmedText = String(text || '').trim();
  if (imageCount <= 0) return trimmedText;

  const imageLabel = imageCount === 1 ? '[图片]' : `[图片${imageCount}张]`;
  if (!trimmedText) return imageLabel;
  return `${trimmedText} ${imageLabel}`.trim();
}

/**
 * [新增] 提取回复引用的原始消息内容
 * 当用户回复某条消息并 @AI 时，提取被引用消息的文本与图片
 */
async function extractQuotedContent(ctx, session) {
  try {
    // Koishi/Satori 协议中，引用消息通过 quote 元素表示
    const quoteEl = session.elements?.find(e => e.type === 'quote');
    if (!quoteEl) return null;

    const quotedId = quoteEl.attrs?.id;
    if (!quotedId) return null;

    // 尝试通过 API 获取被引用的消息
    try {
      const msg = await session.bot.getMessage(session.channelId, quotedId);
      if (msg) {
        const senderName = msg.author?.name || msg.author?.username || msg.author?.nickname || msg.userId || "某人";
        const rawImageCount = Array.isArray(msg.elements)
          ? msg.elements.filter(el => el.type === 'img' || el.type === 'image').length
          : 0;
        const { text: parsedText, images } = await parseMessageContent(ctx, msg.content || '', msg.elements || []);
        const imageCount = Math.max(rawImageCount, images.length);
        const summaryText = buildQuotedTextSummary(parsedText, imageCount);

        if (summaryText || imageCount > 0) {
          logger.debug(`提取到引用消息: [${senderName}] 文本${parsedText.length}字 图片${images.length}/${imageCount}张 ${summaryText.substring(0, 50)}...`);
          return {
            senderName,
            text: summaryText,
            rawText: parsedText,
            images,
            imageCount,
            resolvedImageCount: images.length,
            quotedId,
          };
        }
      }
    } catch (e) {
      logger.debug(`获取引用消息失败(可能平台不支持): ${e.message}`);
    }

    return null;
  } catch (e) {
    return null;
  }
}

module.exports = { downloadImageAsBase64, parseMessageContent, extractQuotedContent };
