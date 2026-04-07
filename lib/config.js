/**
 * config.js — 配置加载、保存、默认值模板
 */

const { Schema } = require('koishi');
const fs = require('fs');
const path = require('path');
const state = require('./state');
const logger = require('./logger');

const name = "enhanced-nekoai";
const usage = `
Enhanced NekoAI 多模态拟人 AI 聊天插件 (模块化架构版)
1. **配置脱离**：所有配置项已转移至运行目录下的 JSON 文件。
2. **多模型/多人格管理**：独立 api_config.json 和 *_personality.json，支持指令热切换。
3. **智能路由**：可选的自动故障转移与负载均衡系统。
4. **长期记忆**：对话上下文持久化，重启不丢失。
`;

const Config = Schema.object({
  _notice: Schema.string().description("⚠️ 必看说明：本插件已全面迁移至本地 JSON 配置。请前往插件目录下的 json 文件进行所有参数设置。修改后可用聊天指令【neko.重载配置】瞬间生效，无需重启！").default("请使用指令或直接修改 JSON 文件进行配置")
});

// --- 文件名常量 ---
const FILES = {
  RUNTIME: "runtime_config.json",
  API: "api_config.json",
  IMAGE_API: "image_api_config.json",
  GROUP_PERSONALITY: "group_personality.json",
  PRIVATE_PERSONALITY: "private_personality.json",
  COMMANDS: "commands.json",
  USAGE_COUNTS: "group_usage_counts.json",
  IMAGE_USAGE_COUNTS: "image_usage_counts.json"
};

const BASE_DIR = path.join(__dirname, '..');

// --- 默认配置模板 ---
const defaultRuntimeConfig = {
  "_comments": {
    "masterQQ": "主人QQ号列表(字符串数组)，拥有各项高级指令的最高权限",
    "nickName": "机器人的称呼/昵称，用于防触发和语境代入",
    "activeApiIndex": "当前使用的聊天API节点编号（对应 api_config.json 的索引，从 0 开始）",
    "activeImageApiIndex": "当前使用的图像API节点编号（对应 image_api_config.json 的索引，从 0 开始）",
    "activeGroupPersonalityIndex": "当前使用的群聊人格编号（对应 group_personality.json 的索引）",
    "activePrivatePersonalityIndex": "当前使用的私聊人格编号（对应 private_personality.json 的索引）",
    "forwardModelList": "是否以合并转发形式输出模型列表 (true/false)",
    "modelListImageEnabled": "模型列表是否启用图片分页渲染 (true/false)",
    "maxGroupMessages": "群聊时允许保留的最长历史上下文记录条数",
    "enableMemes": "是否启用本地表情包功能 (true/false)",
    "memesPath": "本地表情包文件夹的绝对路径或相对路径",
    "memeProb": "触发表情包的概率 (0-1)",
    "sleepTime": "话痨模式下，每句话之间的冷却间隔时间(ms)",
    "randomReply": "话痨模式：满足检测条数后，触发被动插嘴回复的概率 (0-1)",
    "messagesLength": "话痨模式：群聊每积累多少条消息检测一次是否要插嘴",
    "forwardMaxLength": "合并转发机制：触发合并打包的总字数阈值",
    "forwardMaxSegments": "合并转发机制：触发合并打包的分段数阈值",
    "forwardStrategy": "合并转发机制：控制是否启用。可选值：auto(自动)、on(强制开启)、off(强制关闭)",
    "eachLetterCost": "模拟打字延迟：每个字等待的毫秒数",
    "allowPrivateTalkingUsers": "允许私聊的用户ID列表（白名单）",
    "groups": "允许机器人监听、记录和回复的群号列表",
    "privateRefuse": "仅主人模式或非好友私聊时的拒绝回复语",
    "singleAskSleep": "群聊中被@后的个人冷却时间(ms)",
    "singleTalkWaiting": "私聊判定等待时间(ms，防连续多条消息吞字)",
    "singleMaxMessages": "私聊历史消息上下文上限",
    "groupLimits": "群聊12小时回复限制字典 { '群号': 限制次数 }",
    "logLevel": "日志输出级别: debug(全部) / info(常规) / warn(警告) / error(仅错误)",
    "userBlacklist": "用户黑名单QQ号列表（完全屏蔽）",
    "groupPersonalityMap": "按群独立人格绑定 { '群号': 人格索引 }",
    "groupApiMap": "按群独立模型绑定 { '群号': API节点索引 }",
    "groupMentionWait": "群聊@合并等待时间(ms)，0=不等待立即响应",
    "groupMentionFocusMode": "群聊@专注回答模式：被@时以本轮消息为主问题，上下文仅供参考，默认开启",
    "contextAutoForgetMs": "上下文闲置自动清空时间(ms)，0=关闭自动清空",
    "imageQuota": "图像限额配置：控制生图/修图默认额度与指定QQ的单独额度",
    "apiTimeoutMs": "调用下游 API 的超时时间(ms)",
    "sendProcessingNotice": "收到请求后是否先发送“处理中”提示",
    "processingNoticeText": "请求已受理时发送的提示文案",
    "processingNoticeDelayMs": "发送处理中提示前的等待时间(ms)，0=立刻发送",
    "sendFailureNotice": "请求失败时是否在聊天里回报错误",
    "failureNoticeDetailMode": "失败提示详情模式：full=节点+错误详情，brief=仅节点，off=仅通用失败文案",
    "generationFailedText": "生成失败时统一附加的重试提示文案",
    "uiStyle": "图片卡片风格编号：1=极光玻璃，2=深色终端，3=暖纸卡片",
    "smartRouter": "智能路由配置（需手动开启）",
    "apiParams": "API请求参数（temperature, maxTokens等）",
    "memorySummary": "记忆摘要压缩配置",
    "requestQueue": "请求队列并发与排队上限配置"
  },
  "masterQQ": [],
  "nickName": "Neko",
  "activeApiIndex": 0,
  "activeImageApiIndex": 0,
  "activeGroupPersonalityIndex": 0,
  "activePrivatePersonalityIndex": 0,
  "forwardModelList": true,
  "modelListImageEnabled": false,
  "maxGroupMessages": 20,
  "enableMemes": false,
  "memesPath": "",
  "memeProb": 1.0,
  "sleepTime": 1000,
  "randomReply": 0.3,
  "messagesLength": 15,
  "forwardMaxLength": 300,
  "forwardMaxSegments": 5,
  "forwardStrategy": "auto",
  "eachLetterCost": 1,
  "allowPrivateTalkingUsers": [],
  "groups": [],
  "privateRefuse": "我的主人不让我和陌生人说话，当前是仅主人模式",
  "singleAskSleep": 1000,
  "singleTalkWaiting": 500,
  "singleMaxMessages": 40,
  "groupLimits": {},
  // --- 新增字段 ---
  "logLevel": "debug",
  "userBlacklist": [],
  "groupPersonalityMap": {},
  "groupApiMap": {},
  "groupMentionWait": 0,
  "groupMentionFocusMode": true,
  "contextAutoForgetMs": 600000,
  "imageQuota": {
    "enabled": false,
    "defaultGenerateLimit": 0,
    "defaultEditLimit": 0,
    "userLimits": {}
  },
  "apiTimeoutMs": 120000,
  "sendProcessingNotice": true,
  "processingNoticeText": "已接收到请求，请耐心等待处理。请不要在短时间内重复发送请求。2分钟内未完成再重试。(本消息30秒后撤回)",
  "processingNoticeDelayMs": 0,
  "sendFailureNotice": true,
  "failureNoticeDetailMode": "full",
  "generationFailedText": "本次生成已失败，请重试。",
  "uiStyle": 1,
  "smartRouter": {
    "enabled": false,
    "mode": "failover",
    "retryCount": 2,
    "retryDelay": 1000,
    "excludeIndices": []
  },
  "apiParams": {
    "temperature": 0.65,
    "maxTokens": 32000,
    "anthropicMaxTokens": 4096,
    "geminiMaxTokens": 8192
  },
  "memorySummary": {
    "enabled": false,
    "threshold": 30,
    "summaryPrompt": "请用不超过200字的中文总结以下对话中的关键信息、人物关系和重要结论，不要遗漏任何重要细节："
  },
  "requestQueue": {
    "maxConcurrent": 3,
    "maxPending": 10,
    "overflowText": "NEKOAI请求队列已达上限，当前前方有{ahead}个请求未完成。请稍后重试。"
  }
};

const defaultApiConfig = [
  { "apiUrl": "https://api.example.com/v1/chat/completions", "modelName": "gpt-4o-mini", "apiKey": "sk-your-openai-compatible-key", "remark": "OpenAI 兼容示例", "aiType": "openai", "xaiWebSearchEnabled": false },
  { "apiUrl": "https://api.openai.com/v1/responses", "modelName": "gpt-4o-mini", "apiKey": "sk-your-openai-key", "remark": "OpenAI Responses 示例", "aiType": "responses", "xaiWebSearchEnabled": false },
  { "apiUrl": "https://api.anthropic.com/v1/messages", "modelName": "claude-3-5-sonnet-latest", "apiKey": "sk-ant-your-anthropic-key", "remark": "Anthropic 示例", "aiType": "anthropic", "xaiWebSearchEnabled": false },
  { "apiUrl": "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent", "modelName": "gemini-2.0-flash", "apiKey": "AIza-your-gemini-key", "remark": "Gemini 示例", "aiType": "gemini", "xaiWebSearchEnabled": false }
];

const defaultImageApiConfig = [
  { "providerType": "xai", "generationUrl": "https://api.x.ai/v1/images/generations", "editUrl": "https://api.x.ai/v1/images/edits", "apiKey": "xai-your-key", "modelName": "grok-imagine-image", "remark": "xAI 官方图像示例", "aspectRatio": "", "resolution": "" }
];

function extractLegacyImageNode(apiNode, index) {
  const generationUrl = String(apiNode?.xaiImageGenerationUrl || '').trim();
  const editUrl = String(apiNode?.xaiImageEditUrl || '').trim();
  const enabled = apiNode?.xaiImageEnabled === true || !!generationUrl || !!editUrl;
  if (!enabled) return null;
  return {
    providerType: 'xai',
    generationUrl,
    editUrl,
    apiKey: apiNode?.apiKey || '',
    modelName: apiNode?.xaiImageModel || 'grok-imagine-image',
    remark: apiNode?.remark ? `${apiNode.remark} - 图像` : `迁移图像节点 #${index}`,
    aspectRatio: apiNode?.xaiImageAspectRatio || '',
    resolution: apiNode?.xaiImageResolution || '',
  };
}

function stripLegacyImageFields(apiNode) {
  const next = { ...apiNode };
  delete next.xaiImageEnabled;
  delete next.xaiImageGenerationUrl;
  delete next.xaiImageEditUrl;
  delete next.xaiImageModel;
  delete next.xaiImageAspectRatio;
  delete next.xaiImageResolution;
  return next;
}

const defaultGroupPersonality = [
  { "remark": "默认人格", "prompt": "[你的核心设定]\n你叫 Neko，是一个友善、活泼的AI助手。你正在一个QQ群里聊天。\n\n[@回答优先规则]\n当群友@你时，必须把对方本轮@消息当成当前唯一主问题。历史上下文和引用消息只能作为参考，除非对方明确要求总结聊天记录，否则禁止主动总结整段群聊。\n\n[回复风格]\n1. 说话口语化，拒绝AI味。\n2. 表情使用：[wink][不要][拒绝][担心][尴尬][万用][微笑][疑惑][自信]" }
];

const defaultPrivatePersonality = [
  { "remark": "默认私聊人格", "prompt": "[私聊设定]\n你叫 Neko，正在与对方私聊。保持友善和活泼。\n\n[表情使用规则]\n只能使用：[wink][不要][拒绝][担心][尴尬][万用][微笑][疑惑][自信]" }
];

// --- 加载/保存函数 ---

function loadAllConfigs() {
  // 1. 运行配置
  const runPath = path.join(BASE_DIR, FILES.RUNTIME);
  if (!fs.existsSync(runPath)) {
    fs.writeFileSync(runPath, JSON.stringify(defaultRuntimeConfig, null, 2), "utf-8");
    state.runtimeConfig = JSON.parse(JSON.stringify(defaultRuntimeConfig));
    logger.info("已创建默认的 runtime_config.json");
  } else {
    try {
      state.runtimeConfig = JSON.parse(fs.readFileSync(runPath, "utf-8"));
      let updated = false;
      for (let key in defaultRuntimeConfig) {
        if (state.runtimeConfig[key] === undefined) {
          state.runtimeConfig[key] = defaultRuntimeConfig[key];
          updated = true;
        }
      }
      // 深层补丁：smartRouter / apiParams / memorySummary / requestQueue / imageQuota / _comments
      for (const deepKey of ['smartRouter', 'apiParams', 'memorySummary', 'requestQueue', 'imageQuota', '_comments']) {
        if (typeof state.runtimeConfig[deepKey] === 'object' && typeof defaultRuntimeConfig[deepKey] === 'object') {
          for (let subKey in defaultRuntimeConfig[deepKey]) {
            if (state.runtimeConfig[deepKey][subKey] === undefined) {
              state.runtimeConfig[deepKey][subKey] = defaultRuntimeConfig[deepKey][subKey];
              updated = true;
            }
          }
        }
      }
      if (updated) saveRuntimeConfig();
    } catch (e) { logger.error("读取 runtime_config 失败", e.message); }
  }

  // 同步黑名单到 state
  state.userBlacklist = state.runtimeConfig.userBlacklist || [];

  // 2. API 配置
  const apiPath = path.join(BASE_DIR, FILES.API);
  if (!fs.existsSync(apiPath)) {
    fs.writeFileSync(apiPath, JSON.stringify(defaultApiConfig, null, 2), "utf-8");
    state.apiList = JSON.parse(JSON.stringify(defaultApiConfig));
  } else {
    try { state.apiList = JSON.parse(fs.readFileSync(apiPath, "utf-8")); } catch (e) { state.apiList = []; }
  }

  // 2.5 图像 API 配置
  const imageApiPath = path.join(BASE_DIR, FILES.IMAGE_API);
  if (!fs.existsSync(imageApiPath)) {
    const legacyNodes = state.apiList
      .map((node, index) => extractLegacyImageNode(node, index))
      .filter(Boolean);

    if (legacyNodes.length > 0) {
      state.imageApiList = legacyNodes;
      state.apiList = state.apiList.map(stripLegacyImageFields);
      fs.writeFileSync(imageApiPath, JSON.stringify(state.imageApiList, null, 2), "utf-8");
      saveApiConfig();
      logger.warn(`检测到旧版图像配置仍混在 api_config.json 中，已自动迁移 ${legacyNodes.length} 个节点到 image_api_config.json`);
    } else {
      fs.writeFileSync(imageApiPath, JSON.stringify(defaultImageApiConfig, null, 2), "utf-8");
      state.imageApiList = JSON.parse(JSON.stringify(defaultImageApiConfig));
    }
  } else {
    try { state.imageApiList = JSON.parse(fs.readFileSync(imageApiPath, "utf-8")); } catch (e) { state.imageApiList = []; }
  }

  // 3. 群聊人格
  const gpPath = path.join(BASE_DIR, FILES.GROUP_PERSONALITY);
  if (!fs.existsSync(gpPath)) {
    fs.writeFileSync(gpPath, JSON.stringify(defaultGroupPersonality, null, 2), "utf-8");
    state.groupPersonalityList = JSON.parse(JSON.stringify(defaultGroupPersonality));
  } else {
    try { state.groupPersonalityList = JSON.parse(fs.readFileSync(gpPath, "utf-8")); } catch (e) { state.groupPersonalityList = []; }
  }

  // 4. 私聊人格
  const ppPath = path.join(BASE_DIR, FILES.PRIVATE_PERSONALITY);
  if (!fs.existsSync(ppPath)) {
    fs.writeFileSync(ppPath, JSON.stringify(defaultPrivatePersonality, null, 2), "utf-8");
    state.privatePersonalityList = JSON.parse(JSON.stringify(defaultPrivatePersonality));
  } else {
    try { state.privatePersonalityList = JSON.parse(fs.readFileSync(ppPath, "utf-8")); } catch (e) { state.privatePersonalityList = []; }
  }

  // 5. 群聊计数
  const { getPeriodInfo } = require('./utils');
  const usagePath = path.join(BASE_DIR, FILES.USAGE_COUNTS);
  const currentPeriod = getPeriodInfo();
  if (!fs.existsSync(usagePath)) {
    state.usageData = { periodId: currentPeriod, counts: {} };
    fs.writeFileSync(usagePath, JSON.stringify(state.usageData, null, 2), "utf-8");
  } else {
    try {
      state.usageData = JSON.parse(fs.readFileSync(usagePath, "utf-8"));
      if (state.usageData.periodId !== currentPeriod) {
        state.usageData = { periodId: currentPeriod, counts: {} };
        saveUsageCounts();
      }
    } catch (e) { state.usageData = { periodId: currentPeriod, counts: {} }; }
  }

  // 5.5 图像用量计数
  const imageUsagePath = path.join(BASE_DIR, FILES.IMAGE_USAGE_COUNTS);
  if (!fs.existsSync(imageUsagePath)) {
    state.imageUsageData = { periodId: currentPeriod, users: {} };
    fs.writeFileSync(imageUsagePath, JSON.stringify(state.imageUsageData, null, 2), "utf-8");
  } else {
    try {
      state.imageUsageData = JSON.parse(fs.readFileSync(imageUsagePath, "utf-8"));
      if (state.imageUsageData.periodId !== currentPeriod) {
        state.imageUsageData = { periodId: currentPeriod, users: {} };
        saveImageUsageCounts();
      }
    } catch (e) { state.imageUsageData = { periodId: currentPeriod, users: {} }; }
  }

  // 6. 确保目录存在
  const historyDir = path.join(BASE_DIR, 'chat-history');
  if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir);
  const memGroupDir = path.join(BASE_DIR, 'memory', 'group');
  if (!fs.existsSync(memGroupDir)) fs.mkdirSync(memGroupDir, { recursive: true });
  const memPrivateDir = path.join(BASE_DIR, 'memory', 'private');
  if (!fs.existsSync(memPrivateDir)) fs.mkdirSync(memPrivateDir, { recursive: true });

  logger.critical(`配置全量加载完毕 (聊天API节点:${state.apiList.length} | 图像API节点:${state.imageApiList.length} | 群聊人格:${state.groupPersonalityList.length} | 私聊人格:${state.privatePersonalityList.length} | 黑名单:${state.userBlacklist.length}人 | 智能路由:${state.runtimeConfig.smartRouter?.enabled ? '开' : '关'})`);
}

function saveRuntimeConfig() {
  try { fs.writeFileSync(path.join(BASE_DIR, FILES.RUNTIME), JSON.stringify(state.runtimeConfig, null, 2), "utf-8"); }
  catch (e) { logger.error("保存 runtime_config 失败", e.message); }
}

function saveApiConfig() {
  try { fs.writeFileSync(path.join(BASE_DIR, FILES.API), JSON.stringify(state.apiList, null, 2), "utf-8"); }
  catch (e) { logger.error("保存 api_config 失败", e.message); }
}

function saveImageApiConfig() {
  try { fs.writeFileSync(path.join(BASE_DIR, FILES.IMAGE_API), JSON.stringify(state.imageApiList, null, 2), "utf-8"); }
  catch (e) { logger.error("保存 image_api_config 失败", e.message); }
}

function saveGroupPersonality() {
  try { fs.writeFileSync(path.join(BASE_DIR, FILES.GROUP_PERSONALITY), JSON.stringify(state.groupPersonalityList, null, 2), "utf-8"); }
  catch (e) { logger.error("保存 group_personality 失败", e.message); }
}

function savePrivatePersonality() {
  try { fs.writeFileSync(path.join(BASE_DIR, FILES.PRIVATE_PERSONALITY), JSON.stringify(state.privatePersonalityList, null, 2), "utf-8"); }
  catch (e) { logger.error("保存 private_personality 失败", e.message); }
}

function saveUsageCounts() {
  try { fs.writeFileSync(path.join(BASE_DIR, FILES.USAGE_COUNTS), JSON.stringify(state.usageData, null, 2), "utf-8"); }
  catch (e) { logger.error("保存计数文件失败", e.message); }
}

function saveImageUsageCounts() {
  try { fs.writeFileSync(path.join(BASE_DIR, FILES.IMAGE_USAGE_COUNTS), JSON.stringify(state.imageUsageData, null, 2), "utf-8"); }
  catch (e) { logger.error("保存图像计数文件失败", e.message); }
}

module.exports = {
  name, usage, Config, FILES, BASE_DIR, defaultRuntimeConfig,
  loadAllConfigs, saveRuntimeConfig, saveApiConfig,
  saveImageApiConfig, saveGroupPersonality, savePrivatePersonality, saveUsageCounts, saveImageUsageCounts
};
