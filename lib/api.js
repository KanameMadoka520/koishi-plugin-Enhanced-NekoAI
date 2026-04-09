/**
 * api.js — AI API 调用核心
 * 包含：三协议 Payload 组装、智能路由、故障转移、响应计时、可配置参数
 */

const state = require('./state');
const logger = require('./logger');
const { enqueue, QueueOverflowError } = require('./queue');

function getApiParams() {
  return state.runtimeConfig.apiParams || { temperature: 0.65, maxTokens: 32000, anthropicMaxTokens: 4096, geminiMaxTokens: 8192 };
}

function getApiTimeoutMs() {
  const value = Number(state.runtimeConfig.apiTimeoutMs);
  if (!Number.isFinite(value) || value <= 0) return 120000;
  return Math.floor(value);
}

function getSmartRouter() {
  return state.runtimeConfig.smartRouter || { enabled: false, mode: 'failover', retryCount: 2, retryDelay: 1000, excludeIndices: [] };
}

function resolveAiType(apiNode) {
  const rawType = String(apiNode?.aiType || 'openai').toLowerCase();
  const apiUrl = String(apiNode?.apiUrl || '');
  if (rawType === 'response' || rawType === 'responses' || rawType === 'openai-response') return 'responses';
  if (rawType === 'openai' && /\/responses(?:\?|$)/i.test(apiUrl)) return 'responses';
  return rawType;
}

function shouldEnableXaiWebSearch(apiNode, aiType) {
  return aiType === 'responses' && apiNode?.xaiWebSearchEnabled === true;
}

function buildXaiImageConfig(apiNode) {
  return {
    model: String(apiNode?.modelName || '').trim() || 'grok-imagine-image',
    generationUrl: String(apiNode?.generationUrl || '').trim(),
    editUrl: String(apiNode?.editUrl || '').trim(),
    aspectRatio: String(apiNode?.aspectRatio || '').trim(),
    resolution: String(apiNode?.resolution || '').trim(),
  };
}

function buildXaiImageInputItem(image) {
  const url = typeof image?.url === 'string' ? image.url.trim() : '';
  if (!url) return null;
  return { type: 'image_url', url };
}

function sanitizeUrlForLog(url) {
  const raw = String(url || '').trim();
  if (!raw) return '[空URL]';
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return raw.replace(/\?.*$/, '').slice(0, 200);
  }
}

function sanitizeErrorText(text, limit = 400) {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function buildImageRequestErrorInfo(err) {
  const timeoutMs = getApiTimeoutMs();
  const status = err?.response?.status || err?.status || 0;
  const code = String(err?.code || err?.cause?.code || '').trim();
  const name = String(err?.name || err?.cause?.name || '').trim();
  const rawMessage = sanitizeErrorText(err?.message || '', 240);
  const causeMessage = sanitizeErrorText(err?.cause?.message || '', 240);
  const responseDetail = extractApiErrorMessage(err);
  const lowerMessage = `${rawMessage} ${causeMessage}`.toLowerCase();

  let summary = '图像请求失败';
  if (status) {
    summary = `图像接口返回 HTTP ${status}`;
  } else if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out') || code === 'ETIMEDOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    summary = `图像请求超时（${timeoutMs}ms）`;
  } else if (lowerMessage.includes('terminated') || code === 'UND_ERR_SOCKET' || code === 'ECONNRESET') {
    summary = '图像请求在响应完成前被远端中断';
  } else if (code === 'ECONNREFUSED') {
    summary = '图像接口拒绝连接';
  } else if (lowerMessage.includes('fetch failed') || lowerMessage.includes('network error') || lowerMessage.includes('socket hang up')) {
    summary = '图像请求网络失败';
  }

  const publicParts = [summary];
  if (status && responseDetail && !responseDetail.startsWith(`HTTP ${status}`)) {
    publicParts.push(responseDetail);
  } else if (!status && responseDetail && responseDetail !== rawMessage) {
    publicParts.push(responseDetail);
  } else if (!status && rawMessage) {
    publicParts.push(`原始错误：${rawMessage}`);
  }
  if (causeMessage && causeMessage !== rawMessage) {
    publicParts.push(`底层原因：${causeMessage}`);
  }

  const publicMessage = sanitizeErrorText(publicParts.join('；'), 320) || '图像请求失败';
  const logMessage = [
    `摘要=${summary}`,
    `status=${status || '-'}`,
    `code=${code || '-'}`,
    `name=${name || '-'}`,
    `message=${rawMessage || '-'}`,
    `cause=${causeMessage || '-'}`,
    `response=${responseDetail || '-'}`,
  ].join(' ');

  return { publicMessage, logMessage };
}

function getXaiImageFallbackModel(modelName) {
  const normalized = String(modelName || '').trim().toLowerCase();
  if (normalized === 'grok-imagine-image-pro') return 'grok-imagine-image';
  return '';
}

function shouldRetryXaiImageWithFallbackModel(err, modelName) {
  const fallbackModel = getXaiImageFallbackModel(modelName);
  if (!fallbackModel) return false;

  const status = err?.response?.status || err?.status || 0;
  const detail = sanitizeErrorText(
    err?.response?.data?.error?.message
    || err?.response?.data?.message
    || extractApiErrorMessage(err)
    || err?.message
    || '',
    400,
  ).toLowerCase();

  if (![500, 503].includes(status)) return false;

  return detail.includes('temporarily unavailable')
    || detail.includes('service unavailable')
    || detail.includes('model is temporarily unavailable')
    || detail.includes('the service is currently unavailable')
    || detail.includes('internal error')
    || detail.includes('failed to generate image');
}

async function normalizeXaiImageOutputs(ctx, data) {
  const { downloadImageAsBase64 } = require('./parser');
  const outputs = [];
  const items = Array.isArray(data?.data) ? data.data : [];

  for (const item of items) {
    const b64 = typeof item?.b64_json === 'string' ? item.b64_json.trim() : '';
    if (b64) {
      outputs.push({ type: 'base64', data: b64 });
      continue;
    }

    const imageUrl = typeof item?.url === 'string' ? item.url.trim() : '';
    if (!imageUrl) continue;

    const asDataUri = await downloadImageAsBase64(ctx, imageUrl);
    if (asDataUri) {
      const rawBase64 = asDataUri.replace(/^data:image\/\w+;base64,/, '');
      outputs.push({ type: 'base64', data: rawBase64 });
    } else {
      outputs.push({ type: 'url', url: imageUrl });
    }
  }

  return outputs;
}

async function postXaiImageRequest(ctx, requestUrl, payload, headers) {
  try {
    return await enqueue(() => ctx.http.post(requestUrl, payload, { headers, timeout: getApiTimeoutMs() }));
  } catch (err) {
    const status = err?.response?.status || err?.status || 0;
    const detail = String(err?.response?.data?.error?.message || err?.response?.data?.message || err?.message || '').toLowerCase();
    const canRetryWithoutBase64 = payload?.response_format === 'b64_json' && [400, 404, 415, 422].includes(status)
      && (detail.includes('response_format') || detail.includes('b64_json') || detail.includes('image_format'));
    if (!canRetryWithoutBase64) throw err;

    const fallbackPayload = { ...payload };
    delete fallbackPayload.response_format;
    logger.warn(`图像接口不接受 response_format=b64_json，已回退为 URL 响应后再下载图片`);
    return enqueue(() => ctx.http.post(requestUrl, fallbackPayload, { headers, timeout: getApiTimeoutMs() }));
  }
}

async function generateXaiImages(ctx, apiNode, prompt, options = {}) {
  const config = buildXaiImageConfig(apiNode);

  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) {
    throw new Error('提示词不能为空');
  }
  if (!String(apiNode?.apiKey || '').trim()) {
    throw new Error('当前节点缺少 API Key');
  }

  const sourceImages = Array.isArray(options.images) ? options.images.map(buildXaiImageInputItem).filter(Boolean) : [];
  const isEdit = sourceImages.length > 0;
  const requestUrl = isEdit ? config.editUrl : config.generationUrl;
  if (!requestUrl) {
    throw new Error(isEdit ? '当前节点未配置 xAI 图像编辑 URL' : '当前节点未配置 xAI 图像生成 URL');
  }

  const resolvedModel = String(options.model || '').trim() || config.model;
  const requestedCount = Number(options.n);
  const imageCount = Number.isInteger(requestedCount) && requestedCount > 0 ? Math.min(requestedCount, 10) : 1;
  const resolvedAspectRatio = String(options.aspectRatio || '').trim() || config.aspectRatio;
  const resolvedResolution = String(options.resolution || '').trim() || config.resolution;

  const payload = {
    model: resolvedModel,
    prompt: cleanPrompt,
    response_format: 'b64_json',
  };

  if (!isEdit) payload.n = imageCount;
  if (resolvedAspectRatio && (!isEdit || sourceImages.length > 1)) payload.aspect_ratio = resolvedAspectRatio;
  if (resolvedResolution) payload.resolution = resolvedResolution;

  if (isEdit) {
    if (sourceImages.length === 1) payload.image = sourceImages[0];
    else payload.images = sourceImages.slice(0, 5);
  }

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiNode.apiKey}`,
    "User-Agent": "Mozilla/5.0",
  };

  logger.info(`[xAI图像请求] 模式=${isEdit ? '修图' : '生图'} 节点=${apiNode?.remark || apiNode?.modelName || '未命名节点'} URL=${sanitizeUrlForLog(requestUrl)} 模型=${resolvedModel} n=${isEdit ? '-' : imageCount} ratio=${resolvedAspectRatio || '[未设]'} resolution=${resolvedResolution || '[未设]'} 输入图=${sourceImages.length} 提示词长度=${cleanPrompt.length}`);
  let data;
  let finalModel = resolvedModel;
  let modelFallback = null;
  try {
    data = await postXaiImageRequest(ctx, requestUrl, payload, headers);
  } catch (err) {
    if (shouldRetryXaiImageWithFallbackModel(err, resolvedModel)) {
      const fallbackModel = getXaiImageFallbackModel(resolvedModel);
      const fallbackReason = sanitizeErrorText(
        err?.response?.data?.error?.message
        || err?.response?.data?.message
        || extractApiErrorMessage(err)
        || err?.message
        || '上游模型暂时不可用',
        220,
      ) || '上游模型暂时不可用';
      const fallbackPayload = { ...payload, model: fallbackModel };

      logger.warn(`[xAI图像请求回退] 模式=${isEdit ? '修图' : '生图'} 节点=${apiNode?.remark || apiNode?.modelName || '未命名节点'} URL=${sanitizeUrlForLog(requestUrl)} 原模型=${resolvedModel} 回退模型=${fallbackModel} 原因=${fallbackReason}`);

      try {
        data = await postXaiImageRequest(ctx, requestUrl, fallbackPayload, headers);
        finalModel = fallbackModel;
        modelFallback = {
          from: resolvedModel,
          to: fallbackModel,
          reason: fallbackReason,
        };
      } catch (fallbackErr) {
        const fallbackErrorInfo = buildImageRequestErrorInfo(fallbackErr);
        logger.warn(`[xAI图像请求失败] 模式=${isEdit ? '修图' : '生图'} 节点=${apiNode?.remark || apiNode?.modelName || '未命名节点'} URL=${sanitizeUrlForLog(requestUrl)} 模型=${fallbackModel} n=${isEdit ? '-' : imageCount} ratio=${resolvedAspectRatio || '[未设]'} resolution=${resolvedResolution || '[未设]'} 输入图=${sourceImages.length} ${fallbackErrorInfo.logMessage} 回退前模型=${resolvedModel} 回退原因=${fallbackReason}`);
        throw new Error(`${fallbackErrorInfo.publicMessage}（已尝试从 ${resolvedModel} 自动回退到 ${fallbackModel}）`);
      }
    } else {
    const errorInfo = buildImageRequestErrorInfo(err);
    logger.warn(`[xAI图像请求失败] 模式=${isEdit ? '修图' : '生图'} 节点=${apiNode?.remark || apiNode?.modelName || '未命名节点'} URL=${sanitizeUrlForLog(requestUrl)} 模型=${resolvedModel} n=${isEdit ? '-' : imageCount} ratio=${resolvedAspectRatio || '[未设]'} resolution=${resolvedResolution || '[未设]'} 输入图=${sourceImages.length} ${errorInfo.logMessage}`);
    throw new Error(errorInfo.publicMessage);
    }
  }
  const rawImageCount = Array.isArray(data?.data) ? data.data.length : 0;
  const images = await normalizeXaiImageOutputs(ctx, data);
  if (modelFallback) {
    logger.info(`[xAI图像回退成功] 模式=${isEdit ? '修图' : '生图'} 节点=${apiNode?.remark || apiNode?.modelName || '未命名节点'} 原模型=${modelFallback.from} 实际模型=${data?.model || finalModel} 原因=${modelFallback.reason}`);
  }
  logger.info(`[xAI图像响应] 模式=${isEdit ? '修图' : '生图'} 节点=${apiNode?.remark || apiNode?.modelName || '未命名节点'} 原始图片=${rawImageCount} 归一化后=${images.length} moderation=${data?.respect_moderation === undefined ? '未知' : String(data.respect_moderation)}`);
  if (!isEdit && imageCount > 1 && images.length > 0 && images.length < imageCount) {
    logger.warn(`[xAI图像响应] 请求 ${imageCount} 张，但接口仅返回 ${images.length} 张 节点=${apiNode?.remark || apiNode?.modelName || '未命名节点'} URL=${sanitizeUrlForLog(requestUrl)}`);
  }
  if (images.length === 0) {
    throw new Error('图像接口响应中没有可用图片');
  }

  return {
    images,
    raw: data,
    model: data?.model || finalModel,
    moderated: data?.respect_moderation,
    modelFallback,
  };
}

function buildResponsesInput(contextStr, lastMsgContent, currentImages) {
  const input = [];
  if (contextStr) {
    input.push({
      role: 'user',
      content: [{ type: 'input_text', text: contextStr }],
    });
  }

  const latestContent = [];
  if (currentImages && currentImages.length > 0) {
    for (const imgObj of currentImages) {
      const imageUrl = typeof imgObj?.url === 'string' ? imgObj.url.trim() : '';
      if (!imageUrl) continue;
      latestContent.push({ type: 'input_image', image_url: imageUrl });
    }
  }
  latestContent.push({ type: 'input_text', text: String(lastMsgContent || '') });

  input.push({
    role: 'user',
    content: latestContent,
  });

  return input;
}

function extractAnthropicText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const texts = blocks
    .filter(block => block && typeof block.text === 'string' && block.text.trim())
    .map(block => block.text.trim());

  if (texts.length > 0) return texts.join('\n');
  if (typeof data?.completion === 'string' && data.completion.trim()) return data.completion.trim();
  return '';
}

function extractResponsesText(data) {
  const directText = typeof data?.output_text === 'string' ? data.output_text.trim() : '';
  if (directText) return directText;

  const outputItems = Array.isArray(data?.output) ? data.output : [];
  const texts = [];
  for (const item of outputItems) {
    if (typeof item?.text === 'string' && item.text.trim()) texts.push(item.text.trim());
    const contentBlocks = Array.isArray(item?.content) ? item.content : [];
    for (const block of contentBlocks) {
      if (typeof block?.text === 'string' && block.text.trim()) texts.push(block.text.trim());
      if (typeof block?.output_text === 'string' && block.output_text.trim()) texts.push(block.output_text.trim());
    }
  }
  return texts.join('\n').trim();
}

// 判断是否为可重试的错误
function isRetryableError(err) {
  const msg = (err?.message || '').toLowerCase();
  const status = err?.response?.status || err?.status || 0;
  if ([429, 502, 503, 504].includes(status)) return true;
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('econnreset') || msg.includes('econnrefused')) return true;
  if (msg.includes('fetch failed') || msg.includes('network error') || msg.includes('socket hang up')) return true;
  if (msg.includes('rate limit') || msg.includes('too many')) return true;
  return false;
}

function extractApiErrorMessage(err) {
  const status = err?.response?.status || err?.status;
  const responseData = err?.response?.data;

  let detail = '';
  if (typeof responseData === 'string') {
    detail = responseData;
  } else if (responseData && typeof responseData === 'object') {
    detail = responseData.error?.message || responseData.message || JSON.stringify(responseData);
  }

  if (!detail) detail = err?.message || '未知错误';

  let finalMessage = detail;
  if (status) finalMessage = `HTTP ${status}: ${detail}`;

  return String(finalMessage)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

// 选择下一个节点索引（智能路由）
function selectNextNode(currentIndex, excludeSet, mode) {
  const total = state.apiList.length;
  const router = getSmartRouter();
  const globalExclude = new Set([...(router.excludeIndices || []), ...excludeSet]);

  if (mode === 'round-robin') {
    for (let i = 0; i < total; i++) {
      const idx = (state.routerState.roundRobinIndex + i) % total;
      if (!globalExclude.has(idx)) {
        state.routerState.roundRobinIndex = (idx + 1) % total;
        return idx;
      }
    }
  } else if (mode === 'random') {
    const candidates = [];
    for (let i = 0; i < total; i++) { if (!globalExclude.has(i)) candidates.push(i); }
    if (candidates.length > 0) return candidates[Math.floor(Math.random() * candidates.length)];
  } else {
    // failover: 从 currentIndex 之后按顺序找
    for (let i = 1; i < total; i++) {
      const idx = (currentIndex + i) % total;
      if (!globalExclude.has(idx)) return idx;
    }
  }
  return -1; // 无可用节点
}

// 单次 API 调用（不含路由逻辑）
async function callApiOnce(ctx, apiNode, historyTextArray, systemPrompt, currentImages) {
  const params = getApiParams();
  const aiType = resolveAiType(apiNode);

  let payload = {};
  let headers = { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" };
  let requestUrl = apiNode.apiUrl;

  const contextStr = historyTextArray.slice(0, -1).join("");
  const lastMsgContent = historyTextArray[historyTextArray.length - 1];

  if (aiType === "anthropic") {
    let anthropicMessages = [];
    if (contextStr) anthropicMessages.push({ role: "user", content: contextStr });
    let userContent = [];
    if (currentImages && currentImages.length > 0) {
      for (const imgObj of currentImages) {
        if (imgObj.type === 'base64') {
          const base64Data = imgObj.url.replace(/^data:image\/\w+;base64,/, "");
          let mimeType = "image/jpeg";
          const match = imgObj.url.match(/^data:(image\/\w+);base64,/);
          if (match) mimeType = match[1];
          userContent.push({ type: "image", source: { type: "base64", media_type: mimeType, data: base64Data } });
        } else {
          userContent.push({ type: "text", text: `[图片链接: ${imgObj.url}]` });
        }
      }
    }
    userContent.push({ type: "text", text: lastMsgContent });
    anthropicMessages.push({ role: "user", content: userContent });
    payload = { model: apiNode.modelName, system: systemPrompt, messages: anthropicMessages, max_tokens: params.anthropicMaxTokens || 4096, temperature: params.temperature || 0.65 };
    headers["x-api-key"] = apiNode.apiKey;
    headers["anthropic-version"] = "2023-06-01";

  } else if (aiType === "responses") {
    payload = {
      model: apiNode.modelName,
      instructions: systemPrompt,
      input: buildResponsesInput(contextStr, lastMsgContent, currentImages),
      stream: false,
      store: false,
      temperature: params.temperature || 0.65,
      max_output_tokens: params.maxTokens || 32000,
    };
    if (shouldEnableXaiWebSearch(apiNode, aiType)) {
      payload.tools = [{ type: 'web_search' }];
    }
    headers["Authorization"] = `Bearer ${apiNode.apiKey}`;

  } else if (aiType === "gemini") {
    let geminiContents = [];
    if (contextStr) geminiContents.push({ role: "user", parts: [{ text: contextStr }] });
    let userParts = [];
    if (currentImages && currentImages.length > 0) {
      for (const imgObj of currentImages) {
        if (imgObj.type === 'base64') {
          const base64Data = imgObj.url.replace(/^data:image\/\w+;base64,/, "");
          let mimeType = "image/jpeg";
          const match = imgObj.url.match(/^data:(image\/\w+);base64,/);
          if (match) mimeType = match[1];
          userParts.push({ inlineData: { mimeType, data: base64Data } });
        } else {
          userParts.push({ text: `[图片链接: ${imgObj.url}]` });
        }
      }
    }
    userParts.push({ text: lastMsgContent });
    geminiContents.push({ role: "user", parts: userParts });
    payload = { contents: geminiContents, systemInstruction: { parts: [{ text: systemPrompt }] }, generationConfig: { temperature: params.temperature || 0.65, maxOutputTokens: params.geminiMaxTokens || 8192 } };
    headers["x-goog-api-key"] = apiNode.apiKey;
    headers["Authorization"] = `Bearer ${apiNode.apiKey}`;
    if (requestUrl.includes('generativelanguage.googleapis.com') && !requestUrl.includes('key=')) {
      requestUrl += (requestUrl.includes('?') ? '&' : '?') + `key=${apiNode.apiKey}`;
    }

  } else {
    let messages = [{ role: "system", content: systemPrompt }];
    if (contextStr) messages.push({ role: "user", content: contextStr });
    let userPayloadContent = [{ type: "text", text: lastMsgContent }];
    if (currentImages && currentImages.length > 0) {
      for (const imgObj of currentImages) userPayloadContent.push({ type: "image_url", image_url: { url: imgObj.url } });
    }
    let finalUserMessage = { role: "user" };
    if (currentImages.length === 0) finalUserMessage.content = lastMsgContent;
    else finalUserMessage.content = userPayloadContent;
    messages.push(finalUserMessage);
    payload = { model: apiNode.modelName, messages, stream: false, temperature: params.temperature || 0.65, max_tokens: params.maxTokens || 32000 };
    headers["Authorization"] = `Bearer ${apiNode.apiKey}`;
  }

  const data = await ctx.http.post(requestUrl, payload, { headers, timeout: getApiTimeoutMs() });

  // 解析响应
  let content = "skip";
  if (aiType === "anthropic") {
    const anthropicText = extractAnthropicText(data);
    if (anthropicText) content = anthropicText;
  } else if (aiType === "responses") {
    const responsesText = extractResponsesText(data);
    if (responsesText) content = responsesText;
  } else if (aiType === "gemini") {
    if (data && data.candidates && data.candidates.length > 0 && data.candidates[0].content && data.candidates[0].content.parts.length > 0)
      content = data.candidates[0].content.parts[0].text;
  } else {
    if (data && data.choices && data.choices.length > 0) content = data.choices[0].message.content;
  }

  return content;
}

// 主入口：带路由逻辑的 AI 调用
async function getAiReply(ctx, historyTextArray, systemPrompt, currentImages, overrideApiIndex) {
  if (!ctx.http) return { reply: "skip", emoji: "skip", origin: "error", apiInfo: { modelName: "unknown", remark: "unknown" }, responseTime: 0 };

  const router = getSmartRouter();
  let startIndex = overrideApiIndex !== undefined ? overrideApiIndex : (state.runtimeConfig.activeApiIndex || 0);
  if (startIndex < 0 || startIndex >= state.apiList.length) startIndex = 0;

  // 构建尝试列表
  let indicesToTry = [];
  if (!router.enabled) {
    // 智能路由关闭：只用指定节点
    indicesToTry = [startIndex];
    logger.debug(`路由关闭，使用固定节点 #${startIndex}`);
  } else {
    // 智能路由开启：先尝试指定节点，失败后按策略选下一个
    indicesToTry = [startIndex];
    const maxAttempts = Math.min(router.retryCount || 2, state.apiList.length - 1);
    const excludeSet = new Set([startIndex, ...(router.excludeIndices || [])]);
    for (let i = 0; i < maxAttempts; i++) {
      const next = selectNextNode(startIndex, excludeSet, router.mode || 'failover');
      if (next === -1) break;
      indicesToTry.push(next);
      excludeSet.add(next);
    }
    logger.info(`智能路由[${router.mode}]：尝试队列 [${indicesToTry.join(' → ')}]`);
  }

  let lastError = null;
  const t0 = Date.now();

  for (let attempt = 0; attempt < indicesToTry.length; attempt++) {
    const nodeIndex = indicesToTry[attempt];
    const currentApi = state.apiList[nodeIndex];
    if (!currentApi) continue;

    const apiInfo = { modelName: currentApi.modelName, remark: currentApi.remark, nodeIndex };
    const aiType = resolveAiType(currentApi);
    const hasImage = currentImages && currentImages.length > 0;
    const contextLength = historyTextArray.slice(0, -1).join("").length;
    const latestLength = historyTextArray[historyTextArray.length - 1]?.length || 0;

    logger.info(`[尝试 ${attempt + 1}/${indicesToTry.length}] 节点[${currentApi.remark}] 格式[${aiType}] 模型[${currentApi.modelName}] 图片[${hasImage ? currentImages.length + '张' : '无'}] 问题[${latestLength}字] 上下文[${contextLength}字]`);

    try {
      const content = await enqueue(() => callApiOnce(ctx, currentApi, historyTextArray, systemPrompt, currentImages));
      const responseTime = Date.now() - t0;

      if (typeof content !== 'string' || (!content.trim() && content !== 'skip')) {
        throw new Error(`接口响应中缺少可用文本内容 (${aiType})`);
      }

      // 后处理
      const { formatForQQ, GetEmoji } = require('./sender');
      let processed = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      processed = formatForQQ(processed);

      let origin = processed;
      let emoji = GetEmoji(processed);
      if (emoji) processed = processed.split(`[${emoji}]`).join("");
      processed = processed.replace(/\[.*?\]/g, "");

      if (origin.trim().toLowerCase() === "skip") return { reply: "skip", emoji: "skip", origin, apiInfo, responseTime };

      // 拟人分段
      const sentenceRegex = /[^。！？!?;；]+[。！？!?;；]*/g;
      let rawSentences = processed.match(sentenceRegex) || [processed];
      let finalReply = []; let buffer = "";
      for (let seg of rawSentences) {
        if (!seg || seg.trim() === "") continue;
        if (!buffer) { buffer = seg.replace(/^\n+/, ''); continue; }
        let mergeChance = 0.8;
        if (buffer.length > 200) mergeChance = 0.3;
        if (seg.includes('•') || seg.includes('【') || /^\s*\d+\./.test(seg)) mergeChance = 0.98;
        if (Math.random() < mergeChance) buffer += seg;
        else { finalReply.push(buffer.trimEnd()); buffer = seg.replace(/^\n+/, ''); }
      }
      if (buffer) finalReply.push(buffer.trimEnd());

      logger.info(`API 调用成功 [${currentApi.remark}] 耗时 ${responseTime}ms，回复 ${origin.length} 字`);
      return { reply: finalReply, emoji, origin, apiInfo, responseTime };

    } catch (err) {
      const responseTime = Date.now() - t0;
      if (err instanceof QueueOverflowError || err?.code === 'QUEUE_OVERFLOW') {
        const snapshot = err.snapshot || {};
        logger.warn(`请求队列已达上限，停止本次调用。运行中: ${snapshot.running ?? 0}/${snapshot.maxConcurrent ?? 0}，排队: ${snapshot.pending ?? 0}/${snapshot.maxPending ?? 0}`);
        return {
          reply: err.message || 'NEKOAI请求队列已达上限，请稍后重试。',
          emoji: 'skip',
          origin: 'queue_overflow',
          errorMsg: err.message || '请求队列已达上限',
          apiInfo,
          responseTime,
          queueSnapshot: snapshot,
        };
      }

      lastError = err;
      const errMsg = extractApiErrorMessage(err);
      logger.warn(`节点 #${nodeIndex} [${currentApi.remark}] 请求失败: ${errMsg}`);

      // 图片处理失败的特殊情况
      if (currentImages && currentImages.length > 0 && !isRetryableError(err)) {
        logger.error(`图片处理失败，该模型可能不支持视觉，不再重试`);
        return { reply: "无法处理此图片，请更换具有视觉理解的模型或者检查后台日志。", emoji: "尴尬", origin: "error", errorMsg: errMsg || "图片处理失败", apiInfo, responseTime };
      }

      if (!router.enabled || !isRetryableError(err)) {
        // 路由关闭或不可重试的错误，直接返回
        if (router.enabled) logger.warn(`错误不可重试(${err?.response?.status || '未知状态码'})，停止尝试`);
        return { reply: "skip", emoji: "skip", origin: "error", errorMsg: errMsg, apiInfo, responseTime };
      }

      // 路由开启且可重试，等待后继续
      if (attempt < indicesToTry.length - 1) {
        const delay = router.retryDelay || 1000;
        logger.info(`等待 ${delay}ms 后尝试下一个节点...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // 所有节点都失败了
  const responseTime = Date.now() - t0;
  const errMsg = extractApiErrorMessage(lastError);
  logger.error(`所有 ${indicesToTry.length} 个节点均失败，最后错误: ${errMsg}`);
  return { reply: "skip", emoji: "skip", origin: "error", errorMsg: errMsg || "所有节点失败", apiInfo: { modelName: "all-failed", remark: "all-failed" }, responseTime };
}

module.exports = { getAiReply, generateXaiImages };
