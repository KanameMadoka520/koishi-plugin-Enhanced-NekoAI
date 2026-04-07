/**
 * ratelimit.js — 群聊限流系统
 */

const state = require('./state');
const logger = require('./logger');
const { saveUsageCounts, saveImageUsageCounts } = require('./config');
const { getPeriodInfo, getNextPeriodResetText } = require('./utils');

async function checkAndUpdateGroupLimit(session, isMasterUser) {
  const gid = session.channelId;
  if (!state.runtimeConfig.groupLimits || state.runtimeConfig.groupLimits[gid] === undefined) return true;

  const limit = state.runtimeConfig.groupLimits[gid];
  const currentPeriod = getPeriodInfo();

  if (state.usageData.periodId !== currentPeriod) {
    state.usageData.periodId = currentPeriod;
    state.usageData.counts = {};
    logger.info(`限流周期已切换至 ${currentPeriod}，计数已重置`);
  }

  let currentCount = state.usageData.counts[gid] || 0;

  if (currentCount >= limit) {
    if (isMasterUser) {
      state.usageData.counts[gid] = currentCount + 1;
      saveUsageCounts();
      logger.debug(`主人越权调用，群 ${gid} 当前 ${currentCount + 1}/${limit}`);
      return true;
    } else {
      logger.info(`群 ${gid} 已达限额 ${limit}，拒绝非主人请求`);
      return false;
    }
  }

  currentCount++;
  state.usageData.counts[gid] = currentCount;
  saveUsageCounts();

  const halfLimit = Math.floor(limit * 0.5);
  const eightyLimit = Math.floor(limit * 0.8);

  if (currentCount === halfLimit) {
    await session.send(`⚠️ 提示：本群聊本12小时周期内的AI调用次数已达 50% (${currentCount}/${limit})`);
  } else if (currentCount === eightyLimit) {
    await session.send(`⚠️ 提示：本群聊本12小时周期内的AI调用次数已达 80% (${currentCount}/${limit})`);
  } else if (currentCount === limit) {
    await session.send(`⚠️ 提示：本群聊本12小时周期内的AI调用次数已耗尽 (${limit}/${limit})！跨越分界线(早/晚6点)前，非主人提问将不再回复。`);
  }

  return true;
}

function normalizeQuotaNumber(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function ensureImageUsagePeriod() {
  const currentPeriod = getPeriodInfo();
  if (state.imageUsageData.periodId !== currentPeriod) {
    state.imageUsageData.periodId = currentPeriod;
    state.imageUsageData.users = {};
    saveImageUsageCounts();
    logger.info(`图像限额周期已切换至 ${currentPeriod}，图像计数已重置`);
  }
  return currentPeriod;
}

function getImageQuotaConfig() {
  const imageQuota = state.runtimeConfig.imageQuota || {};
  return {
    enabled: imageQuota.enabled === true,
    defaultGenerateLimit: normalizeQuotaNumber(imageQuota.defaultGenerateLimit),
    defaultEditLimit: normalizeQuotaNumber(imageQuota.defaultEditLimit),
    userLimits: imageQuota.userLimits && typeof imageQuota.userLimits === 'object' ? imageQuota.userLimits : {},
  };
}

function getImageQuotaLimitForUser(userId, action) {
  const config = getImageQuotaConfig();
  const defaultLimit = action === 'generate' ? config.defaultGenerateLimit : config.defaultEditLimit;
  const userRule = config.userLimits[String(userId)] && typeof config.userLimits[String(userId)] === 'object'
    ? config.userLimits[String(userId)]
    : null;

  if (!userRule) return defaultLimit;
  const overrideValue = action === 'generate' ? userRule.generateLimit : userRule.editLimit;
  if (overrideValue === undefined || overrideValue === null || overrideValue === '') return defaultLimit;
  return normalizeQuotaNumber(overrideValue);
}

function getImageUsageUserStats(userId) {
  ensureImageUsagePeriod();
  const existing = state.imageUsageData.users?.[String(userId)];
  if (existing && typeof existing === 'object') {
    return {
      generate: normalizeQuotaNumber(existing.generate),
      edit: normalizeQuotaNumber(existing.edit),
    };
  }
  return { generate: 0, edit: 0 };
}

function checkImageQuota(session, action, amount = 1, isMasterUser = false) {
  const normalizedAmount = Math.max(1, normalizeQuotaNumber(amount) || 1);
  const currentPeriod = ensureImageUsagePeriod();
  const config = getImageQuotaConfig();
  const userId = String(session.userId || '');
  const actionLabel = action === 'generate' ? '生图' : '修图';

  if (isMasterUser) {
    return {
      allowed: true,
      unlimited: true,
      currentPeriod,
      action,
      actionLabel,
      amount: normalizedAmount,
      limit: null,
      used: 0,
      remaining: null,
      userId,
    };
  }

  if (!config.enabled) {
    return {
      allowed: true,
      unlimited: true,
      currentPeriod,
      action,
      actionLabel,
      amount: normalizedAmount,
      limit: null,
      used: 0,
      remaining: null,
      userId,
    };
  }

  const limit = getImageQuotaLimitForUser(userId, action);
  const stats = getImageUsageUserStats(userId);
  const used = action === 'generate' ? stats.generate : stats.edit;

  if (limit <= 0) {
    return {
      allowed: true,
      unlimited: true,
      currentPeriod,
      action,
      actionLabel,
      amount: normalizedAmount,
      limit,
      used,
      remaining: null,
      userId,
    };
  }

  const remaining = Math.max(limit - used, 0);
  if (used + normalizedAmount > limit) {
    return {
      allowed: false,
      unlimited: false,
      currentPeriod,
      action,
      actionLabel,
      amount: normalizedAmount,
      limit,
      used,
      remaining,
      userId,
    };
  }

  return {
    allowed: true,
    unlimited: false,
    currentPeriod,
    action,
    actionLabel,
    amount: normalizedAmount,
    limit,
    used,
    remaining: Math.max(limit - used - normalizedAmount, 0),
    userId,
  };
}

function recordImageQuotaUsage(session, action, amount = 1, isMasterUser = false) {
  const normalizedAmount = Math.max(1, normalizeQuotaNumber(amount) || 1);
  if (isMasterUser) {
    return {
      currentPeriod: ensureImageUsagePeriod(),
      action,
      amount: normalizedAmount,
      unlimited: true,
      used: 0,
      remaining: null,
    };
  }

  const config = getImageQuotaConfig();
  if (!config.enabled) {
    return {
      currentPeriod: ensureImageUsagePeriod(),
      action,
      amount: normalizedAmount,
      unlimited: true,
      used: 0,
      remaining: null,
    };
  }

  const currentPeriod = ensureImageUsagePeriod();
  const userId = String(session.userId || '');
  const existing = getImageUsageUserStats(userId);
  const next = {
    generate: existing.generate,
    edit: existing.edit,
  };
  if (action === 'generate') next.generate += normalizedAmount;
  else next.edit += normalizedAmount;

  if (!state.imageUsageData.users || typeof state.imageUsageData.users !== 'object') {
    state.imageUsageData.users = {};
  }
  state.imageUsageData.users[userId] = next;
  saveImageUsageCounts();

  const limit = getImageQuotaLimitForUser(userId, action);
  const used = action === 'generate' ? next.generate : next.edit;
  return {
    currentPeriod,
    action,
    amount: normalizedAmount,
    unlimited: limit <= 0,
    used,
    remaining: limit > 0 ? Math.max(limit - used, 0) : null,
  };
}

function buildImageQuotaExceededMessage(result) {
  if (!result) return '❌ 当前图像额度已用尽，请稍后再试。';
  if (result.unlimited) return '';
  return `❌ 你的${result.actionLabel}额度已用尽。\n当前周期：${result.currentPeriod}\n已用 / 上限：${result.used}/${result.limit}\n下次刷新：${getNextPeriodResetText()}\n说明：图像额度按东八区 12 小时周期滚动刷新（06:00 / 18:00）。主人不受此限制，普通群友默认走全局额度；若为指定 QQ 单独配置了额度，则优先使用单独额度。`;
}

function buildImageQuotaUsageNotice(result) {
  if (!result) return '';
  const actionLabel = result.action === 'edit' ? '修图' : '生图';
  if (result.isMasterUser) {
    return `图像额度：主人无限制。\n下次周期切换参考：${getNextPeriodResetText()}（北京时间 06:00 / 18:00 滚动刷新）`;
  }
  if (result.unlimited) {
    return `图像额度：当前账号${actionLabel}不限额。\n下次周期切换参考：${getNextPeriodResetText()}（北京时间 06:00 / 18:00 滚动刷新）`;
  }
  return `本周期已用${actionLabel}额度：${result.used}/${result.limit}\n本周期剩余${actionLabel}额度：${result.remaining}\n下次刷新：${getNextPeriodResetText()}`;
}

module.exports = {
  checkAndUpdateGroupLimit,
  checkImageQuota,
  recordImageQuotaUsage,
  buildImageQuotaExceededMessage,
  buildImageQuotaUsageNotice,
  getImageUsageUserStats,
};
