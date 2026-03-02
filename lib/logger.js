/**
 * logger.js — 日志分级系统
 * 支持 DEBUG / INFO / WARN / ERROR 四级
 * 通过 runtime_config.logLevel 控制输出级别
 * 主人可通过 neko.日志级别 指令实时切换
 */

const state = require('./state');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function getLevel() {
  const cfg = state.runtimeConfig.logLevel || 'debug';
  return LEVELS[cfg.toLowerCase()] !== undefined ? LEVELS[cfg.toLowerCase()] : 0;
}

function ts() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function fmt(level, ...args) {
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  return `[Neko] [${level.toUpperCase()}] [${ts()}] ${msg}`;
}

const logger = {
  debug(...args) {
    if (getLevel() <= LEVELS.debug) console.log(fmt('DEBUG', ...args));
  },
  info(...args) {
    if (getLevel() <= LEVELS.info) console.log(fmt('INFO', ...args));
  },
  warn(...args) {
    if (getLevel() <= LEVELS.warn) console.warn(fmt('WARN', ...args));
  },
  error(...args) {
    if (getLevel() <= LEVELS.error) console.error(fmt('ERROR', ...args));
  },
  // 无论日志级别都输出（启动/关闭等关键信息）
  critical(...args) {
    console.log(fmt('CRITICAL', ...args));
  }
};

module.exports = logger;
