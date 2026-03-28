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

function normalizeMaybeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.replace(/&amp;/g, '&').trim();
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getPlainTextFromContent(content) {
  return String(content || '')
    .replace(/<quote\b[^>]*\/>/gi, ' ')
    .replace(/\[CQ:reply,[^\]]+\]/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function countImageElements(elements) {
  if (!Array.isArray(elements)) return 0;
  return elements.filter((el) => {
    const type = String(el?.type || '').toLowerCase();
    return type === 'img' || type === 'image';
  }).length;
}

function countImagesInRawContent(content) {
  const text = String(content || '');
  const htmlMatches = text.match(/src="([^"]*)"/g) || [];
  const cqMatches = text.match(/\[CQ:image,[^\]]*\]/gi) || [];
  return htmlMatches.length + cqMatches.length;
}

async function parseMessageContent(ctx, content, elements) {
  let textContent = "", imageUrls = [], externalImageUrls = [];

  if (elements && elements.length > 0) {
    for (const el of elements) {
      const type = String(el?.type || '').toLowerCase();
      const attrs = isObject(el?.attrs) ? el.attrs : {};
      const data = isObject(el?.data) ? el.data : {};
      if (type === 'text') {
        textContent += String(attrs.content || attrs.text || data.text || '');
      } else if (type === 'img' || type === 'image') {
        const src = normalizeMaybeUrl(attrs.src || attrs.url || data.url || (/^https?:\/\//i.test(String(data.file || '')) ? data.file : ''));
        if (src) imageUrls.push(src);
      }
    }
  } else {
    const imgRegex = /src="([^"]*)"/g; let match;
    while ((match = imgRegex.exec(content)) !== null) {
      const url = normalizeMaybeUrl(match[1]);
      if (url) imageUrls.push(url);
    }
    const cqImageRegex = /\[CQ:image,[^\]]*url=([^,\]]+)/gi; let cqMatch;
    while ((cqMatch = cqImageRegex.exec(content)) !== null) {
      const url = normalizeMaybeUrl(cqMatch[1]);
      if (url) imageUrls.push(url);
    }
    textContent = getPlainTextFromContent(content);
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

function pickQuotedId(value) {
  if (!isObject(value)) return '';
  const directKeys = ['id', 'messageId', 'message_id', 'msgId', 'msg_id', 'quoteId', 'quote_id', 'sourceId', 'source_id'];
  for (const key of directKeys) {
    if (value[key] !== undefined && value[key] !== null && String(value[key]).trim()) {
      return String(value[key]).trim();
    }
  }
  if (isObject(value.message)) {
    return pickQuotedId(value.message);
  }
  return '';
}

function pickQuotedSenderName(value) {
  if (!isObject(value)) return '某人';
  const sender = isObject(value.sender) ? value.sender : {};
  const author = isObject(value.author) ? value.author : {};
  const candidates = [
    value.senderName,
    value.username,
    value.nickname,
    sender.card,
    sender.nickname,
    sender.name,
    sender.user_id,
    value.userId,
    author.name,
    author.username,
    author.nickname,
    author.userId,
  ];
  for (const item of candidates) {
    if (item !== undefined && item !== null && String(item).trim()) return String(item).trim();
  }
  return '某人';
}

function collectQuoteCandidates(session) {
  const candidates = [];
  const seen = new Set();
  const content = String(session?.content || '');
  const elementTypes = Array.isArray(session?.elements) ? session.elements.map(el => el?.type).filter(Boolean) : [];

  function pushCandidate(label, payload, forcedId = '') {
    if (!payload && !forcedId) return;
    const id = forcedId || pickQuotedId(payload);
    const fingerprint = `${label}:${id || 'no-id'}:${payload ? Object.keys(payload).slice(0, 6).join(',') : 'no-payload'}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    candidates.push({ label, payload, id });
  }

  const quoteEl = Array.isArray(session?.elements)
    ? session.elements.find(e => String(e?.type || '').toLowerCase() === 'quote')
    : null;
  if (quoteEl) pushCandidate('elements.quote', quoteEl?.attrs || {}, String(quoteEl?.attrs?.id || quoteEl?.attrs?.messageId || quoteEl?.attrs?.message_id || ''));

  const contentQuoteMatch = content.match(/<quote\b[^>]*id="([^"]+)"/i);
  if (contentQuoteMatch?.[1]) pushCandidate('content.quote-tag', null, contentQuoteMatch[1]);

  const cqReplyMatch = content.match(/\[CQ:reply,[^\]]*id=([^,\]]+)/i);
  if (cqReplyMatch?.[1]) pushCandidate('content.cq-reply', null, cqReplyMatch[1]);

  const sourcePaths = [
    ['session.quote', session?.quote],
    ['session.reply', session?.reply],
    ['session.source', session?.source],
    ['event.quote', session?.event?.quote],
    ['event.reply', session?.event?.reply],
    ['event.source', session?.event?.source],
    ['event.message.quote', session?.event?.message?.quote],
    ['event.message.reply', session?.event?.message?.reply],
    ['event.message.source', session?.event?.message?.source],
    ['event._data.quote', session?.event?._data?.quote],
    ['event._data.reply', session?.event?._data?.reply],
    ['event._data.source', session?.event?._data?.source],
    ['event._data.message.quote', session?.event?._data?.message?.quote],
    ['event._data.message.reply', session?.event?._data?.message?.reply],
    ['event._data.message.source', session?.event?._data?.message?.source],
  ];

  for (const [label, value] of sourcePaths) {
    if (!value) continue;
    pushCandidate(label, value);
  }

  const debug = {
    elementTypes,
    hasContentQuoteTag: /<quote\b/i.test(content),
    hasCQReply: /\[CQ:reply,/i.test(content),
    hasSessionQuote: !!session?.quote,
    hasSessionReply: !!session?.reply,
    hasSessionSource: !!session?.source,
    eventKeys: Object.keys(session?.event || {}).slice(0, 12),
    eventMessageKeys: Object.keys(session?.event?.message || {}).slice(0, 12),
    eventDataKeys: Object.keys(session?.event?._data || {}).slice(0, 12),
  };

  return { candidates, debug };
}

function buildQuoteDebugSummary(debug, candidates) {
  return `候选${candidates.length}个 elementTypes=[${(debug.elementTypes || []).join(',') || '无'}] contentQuoteTag=${debug.hasContentQuoteTag ? '是' : '否'} contentCQReply=${debug.hasCQReply ? '是' : '否'} session.quote=${debug.hasSessionQuote ? '有' : '无'} session.reply=${debug.hasSessionReply ? '有' : '无'} session.source=${debug.hasSessionSource ? '有' : '无'} eventKeys=[${(debug.eventKeys || []).join(',') || '无'}] event.messageKeys=[${(debug.eventMessageKeys || []).join(',') || '无'}] event._dataKeys=[${(debug.eventDataKeys || []).join(',') || '无'}]`;
}

async function buildQuotedContentFromPayload(ctx, payload, fallback = {}) {
  if (!payload && !fallback.quotedId) return null;

  const elements = Array.isArray(payload?.elements)
    ? payload.elements
    : Array.isArray(payload?.message)
      ? payload.message
      : Array.isArray(payload?.content)
        ? payload.content
        : [];
  const rawContent = typeof payload?.message === 'string'
    ? payload.message
    : (payload?.content || payload?.raw_message || payload?.rawMessage || payload?.text || '');
  const { text: parsedText, images } = await parseMessageContent(ctx, rawContent, elements);
  const imageCount = Math.max(
    countImageElements(elements),
    countImagesInRawContent(rawContent),
    images.length,
    Number(payload?.imageCount || 0),
  );
  const summaryText = buildQuotedTextSummary(parsedText, imageCount);

  if (!summaryText && imageCount <= 0) return null;

  return {
    senderName: fallback.senderName || pickQuotedSenderName(payload),
    text: summaryText,
    rawText: parsedText,
    images,
    imageCount,
    resolvedImageCount: images.length,
    quotedId: fallback.quotedId || pickQuotedId(payload),
    source: fallback.source || 'payload',
  };
}

/**
 * [新增] 提取回复引用的原始消息内容
 * 当用户回复某条消息并 @AI 时，提取被引用消息的文本与图片
 */
async function extractQuotedContent(ctx, session) {
  try {
    const { candidates, debug } = collectQuoteCandidates(session);
    if (candidates.length === 0) {
      logger.debug(`[回复检测] 未发现引用线索。${buildQuoteDebugSummary(debug, candidates)}`);
      return null;
    }

    for (const candidate of candidates) {
      const direct = await buildQuotedContentFromPayload(ctx, candidate.payload, {
        quotedId: candidate.id,
        source: candidate.label,
      });
      if (direct) {
        logger.debug(`提取到引用消息(${candidate.label}): [${direct.senderName}] 文本${direct.rawText.length}字 图片${direct.resolvedImageCount}/${direct.imageCount}张 ${String(direct.text || '').substring(0, 50)}...`);
        return direct;
      }

      if (!candidate.id) continue;

      try {
        const msg = await session.bot.getMessage(session.channelId, candidate.id);
        const fetched = await buildQuotedContentFromPayload(ctx, msg, {
          quotedId: candidate.id,
          source: `${candidate.label}:getMessage`,
        });
        if (fetched) {
          logger.debug(`提取到引用消息(${candidate.label}:getMessage): [${fetched.senderName}] 文本${fetched.rawText.length}字 图片${fetched.resolvedImageCount}/${fetched.imageCount}张 ${String(fetched.text || '').substring(0, 50)}...`);
          return fetched;
        }
      } catch (e) {
        logger.debug(`获取引用消息失败 [${candidate.label}/${candidate.id}] (可能平台不支持): ${e.message}`);
      }
    }

    logger.debug(`[回复检测] 已发现引用线索但提取失败。${buildQuoteDebugSummary(debug, candidates)}`);
    return null;
  } catch (e) {
    logger.debug(`[回复检测] 提取引用异常: ${e.message}`);
    return null;
  }
}

module.exports = { downloadImageAsBase64, parseMessageContent, extractQuotedContent };
