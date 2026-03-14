/**
 * index.js — 入口文件（薄壳）
 * 所有逻辑已拆分至 lib/ 目录下的模块
 */

const { Config, name, usage, loadAllConfigs } = require('./lib/config');
const { registerCommands } = require('./lib/commands');
const { registerListener } = require('./lib/listener');
const { loadMemes } = require('./lib/memes');
const { loadAllMemory } = require('./lib/memory');
const { loadCommandsList, loadGroupFriends } = require('./lib/utils');
const state = require('./lib/state');
const logger = require('./lib/logger');
const inject = {
  optional: ['puppeteer'],
};

function apply(ctx) {
  // 1. 加载所有配置
  loadAllConfigs();

  // 2. 加载表情包
  loadMemes();

  // 3. 初始化群聊状态
  for (let gid of (state.runtimeConfig.groups || [])) {
    if (!state.historyMessages[gid]) state.historyMessages[gid] = [];
    state.messageCount[gid] = 0;
    state.receive[gid] = true;
  }

  // 4. 加载辅助数据
  loadGroupFriends();
  loadCommandsList();

  // 5. 加载长期记忆
  loadAllMemory();

  // 6. 注册指令和监听器
  registerCommands(ctx);
  registerListener(ctx);

  logger.critical('Enhanced-NekoAI (模块化架构版) 已启动');
}

module.exports = { Config, apply, name, usage, inject };
