/**
 * memes.js — 表情包系统
 * 从指定目录加载表情包图片文件到 state.memes
 */

const path = require('path');
const state = require('./state');
const logger = require('./logger');
const { readFilesInDirectory } = require('./utils');

function loadMemes() {
  if (state.runtimeConfig.enableMemes && state.runtimeConfig.memesPath) {
    const memesPath = state.runtimeConfig.memesPath;
    const fs = require('fs');
    if (!fs.existsSync(memesPath)) {
      logger.warn(`表情包目录不存在: ${memesPath}`);
      return;
    }
    for (let key in state.memes) {
      state.memes[key] = readFilesInDirectory(path.join(memesPath, key));
    }
    const total = Object.values(state.memes).reduce((s, arr) => s + arr.length, 0);
    logger.info(`表情包加载完毕：${total} 张 (${Object.keys(state.memes).length} 个分类)`);
  }
}

module.exports = { loadMemes };
