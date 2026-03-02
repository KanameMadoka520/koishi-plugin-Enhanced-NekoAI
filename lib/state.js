/**
 * state.js — 全局共享状态单例
 * 替代原 index.js 中的所有 var 全局变量
 * 所有模块 require 此文件获得同一个对象引用
 */

const state = {
  // --- 群聊运行时状态 ---
  receive: {},            // 群聊被动插嘴冷却锁 { channelId: boolean }
  singleAsk: {},          // @提及冷却锁 { userId: boolean }
  historyMessages: {},    // 群聊上下文 { channelId: string[] }
  messageCount: {},       // 群聊消息计数(话痨触发) { channelId: number }
  groupMentionBuffers: {},// [新增] 群聊@合并等待缓冲 { `${channelId}_${userId}`: { timer, texts:[], images:[], session } }

  // --- 私聊运行时状态 ---
  singleMessages: {},     // 私聊上下文 { userId: string[] }
  privateIntervals: {},   // 私聊防抖定时器 { userId: timeoutId }

  // --- 模式与名单 ---
  privateMode: 'master',  // 私聊模式: 'master' | 'friends'
  groupFriendsMap: {},    // 群友名单缓存 { channelId: string[] }
  blacklistCommands: [],  // Koishi 指令避让列表

  // --- 表情包 ---
  memes: {
    wink: [], 不要: [], 拒绝: [], 担心: [], 尴尬: [], 万用: [], 微笑: [], 疑惑: [], 自信: []
  },

  // --- JSON 配置 ---
  runtimeConfig: {},
  apiList: [],
  groupPersonalityList: [],
  privatePersonalityList: [],

  // --- 群聊限流计数 ---
  usageData: { periodId: "", counts: {} },

  // --- [新增] 智能路由状态 ---
  routerState: {
    roundRobinIndex: 0,       // 轮询当前索引
    failedNodes: {},          // 短期失败记录 { nodeIndex: failTimestamp }
  },

  // --- [新增] 请求队列状态 ---
  queueState: {
    running: 0,
    queue: []
  },

  // --- [新增] 用户黑名单(运行时缓存) ---
  userBlacklist: [],
};

module.exports = state;
