/**
 * ratelimit.js — 聊天 / 图像限额系统
 */

const state = require('./state');
const logger = require('./logger');
const { saveUsageCounts, saveImageUsageCounts } = require('./config');
const { getPeriodInfo, getNextPeriodResetText } = require('./utils');
const { appendUsageEvent } = require('./usage-events');

function ensureChatUsagePeriod() {
  const currentPeriod = getPeriodInfo();
  if (state.usageData.periodId !== currentPeriod) {
    state.usageData.periodId = currentPeriod;
    state.usageData.counts = {};
    state.usageData.users = {};
    saveUsageCounts();
    logger.info(`聊天限额周期已切换至 ${currentPeriod}，聊天计数已重置`);
  }
  if (!state.usageData.counts || typeof state.usageData.counts !== 'object' || Array.isArray(state.usageData.counts)) {
    state.usageData.counts = {};
  }
  if (!state.usageData.users || typeof state.usageData.users !== 'object' || Array.isArray(state.usageData.users)) {
    state.usageData.users = {};
  }
  return currentPeriod;
}

function getChatQuotaConfig() {
  const chatQuota = state.runtimeConfig.chatQuota || {};
  return {
    enabled: chatQuota.enabled === true,
    defaultLimit: normalizeQuotaNumber(chatQuota.defaultLimit),
    userLimits: chatQuota.userLimits && typeof chatQuota.userLimits === 'object' ? chatQuota.userLimits : {},
  };
}

function getChatQuotaLimitForUser(userId) {
  const config = getChatQuotaConfig();
  const userRule = config.userLimits[String(userId)];
  if (userRule === undefined || userRule === null || userRule === '') return config.defaultLimit;
  return normalizeQuotaNumber(userRule);
}

function getChatUsageUserStats(userId) {
  ensureChatUsagePeriod();
  return normalizeQuotaNumber(state.usageData.users?.[String(userId)] ?? 0);
}

function buildChatQuotaExceededMessage(result) {
  if (!result) return '❌ 当前聊天额度已用尽，请稍后再试。';
  if (result.reason === 'group-limit') {
    return `❌ 当前群聊额度已用尽。\n当前周期：${result.currentPeriod}\n已用 / 上限：${result.used}/${result.limit}\n下次刷新：${getNextPeriodResetText()}\n说明：群总额度按东八区 12 小时周期滚动刷新（06:00 / 18:00）。主人不受此限制。`;
  }
  return `❌ 你的聊天额度已用尽。\n当前周期：${result.currentPeriod}\n已用 / 上限：${result.used}/${result.limit}\n下次刷新：${getNextPeriodResetText()}\n说明：聊天个人额度按东八区 12 小时周期滚动刷新（06:00 / 18:00）。主人不受此限制；群总额度仍会与个人额度同时生效。`;
}

async function checkAndUpdateGroupLimit(session, isMasterUser, options = {}) {
  const currentPeriod = ensureChatUsagePeriod();
  const notifyThresholds = options.notifyThresholds !== false;
  const userId = String(session.userId || '');
  const gid = session.isDirect ? '' : String(session.channelId || '');

  const rawGroupLimit = gid && state.runtimeConfig.groupLimits ? state.runtimeConfig.groupLimits[gid] : undefined;
  const groupLimit = rawGroupLimit === undefined ? null : normalizeQuotaNumber(rawGroupLimit);
  const currentGroupCount = gid ? normalizeQuotaNumber(state.usageData.counts?.[gid] ?? 0) : 0;

  const chatQuota = getChatQuotaConfig();
  const currentUserCount = getChatUsageUserStats(userId);
  const userLimit = isMasterUser ? null : getChatQuotaLimitForUser(userId);

  if (!isMasterUser && groupLimit !== null && groupLimit > 0 && currentGroupCount >= groupLimit) {
    logger.info(`群 ${gid} 已达聊天总额度 ${groupLimit}，拒绝非主人请求`);
    appendUsageEvent(session, {
      category: 'chat',
      action: 'chat',
      allowed: false,
      amount: 1,
      reason: 'group-limit',
      isMasterUser,
      detail: { groupLimit, currentGroupCount },
    });
    return {
      allowed: false,
      reason: 'group-limit',
      currentPeriod,
      limit: groupLimit,
      used: currentGroupCount,
      remaining: 0,
      userId,
      channelId: gid || null,
    };
  }

  if (!isMasterUser && chatQuota.enabled && userLimit !== null && userLimit > 0 && currentUserCount >= userLimit) {
    logger.info(`用户 ${userId} 已达聊天个人额度 ${userLimit}，拒绝请求`);
    appendUsageEvent(session, {
      category: 'chat',
      action: 'chat',
      allowed: false,
      amount: 1,
      reason: 'user-limit',
      isMasterUser,
      detail: { userLimit, currentUserCount },
    });
    return {
      allowed: false,
      reason: 'user-limit',
      currentPeriod,
      limit: userLimit,
      used: currentUserCount,
      remaining: 0,
      userId,
      channelId: gid || null,
    };
  }

  let changed = false;
  let nextGroupCount = currentGroupCount;
  let nextUserCount = currentUserCount;

  if (gid && groupLimit !== null && groupLimit > 0) {
    nextGroupCount = currentGroupCount + 1;
    state.usageData.counts[gid] = nextGroupCount;
    changed = true;
  }

  if (!isMasterUser && chatQuota.enabled) {
    nextUserCount = currentUserCount + 1;
    state.usageData.users[userId] = nextUserCount;
    changed = true;
  }

  if (changed) saveUsageCounts();

  if (gid && groupLimit !== null && groupLimit > 0 && notifyThresholds) {
    const halfLimit = Math.floor(groupLimit * 0.5);
    const eightyLimit = Math.floor(groupLimit * 0.8);

    if (nextGroupCount === halfLimit && halfLimit > 0) {
      await session.send(`⚠️ 提示：本群聊本12小时周期内的AI调用次数已达 50% (${nextGroupCount}/${groupLimit})`);
    } else if (nextGroupCount === eightyLimit && eightyLimit > 0) {
      await session.send(`⚠️ 提示：本群聊本12小时周期内的AI调用次数已达 80% (${nextGroupCount}/${groupLimit})`);
    } else if (nextGroupCount === groupLimit) {
      await session.send(`⚠️ 提示：本群聊本12小时周期内的AI调用次数已耗尽 (${groupLimit}/${groupLimit})！跨越分界线(早/晚6点)前，非主人提问将不再回复。`);
    }
  }

  appendUsageEvent(session, {
    category: 'chat',
    action: 'chat',
    allowed: true,
    amount: 1,
    reason: 'ok',
    isMasterUser,
    detail: {
      groupLimit,
      groupUsed: nextGroupCount,
      userLimit,
      userUsed: nextUserCount,
    },
  });

  return {
    allowed: true,
    reason: 'ok',
    currentPeriod,
    group: gid && groupLimit !== null ? {
      limit: groupLimit,
      used: nextGroupCount,
      remaining: groupLimit > 0 ? Math.max(groupLimit - nextGroupCount, 0) : null,
    } : null,
    user: !isMasterUser && chatQuota.enabled ? {
      limit: userLimit,
      used: nextUserCount,
      remaining: userLimit && userLimit > 0 ? Math.max(userLimit - nextUserCount, 0) : null,
    } : null,
  };
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

function recordImageQuotaUsage(session, action, amount = 1, isMasterUser = false, meta = {}) {
  const normalizedAmount = Math.max(1, normalizeQuotaNumber(amount) || 1);
  if (isMasterUser) {
    appendUsageEvent(session, {
      category: 'image',
      action,
      allowed: true,
      amount: normalizedAmount,
      reason: 'ok',
      isMasterUser: true,
      modelName: meta.modelName,
      nodeRemark: meta.nodeRemark,
      detail: meta.detail,
    });
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
    appendUsageEvent(session, {
      category: 'image',
      action,
      allowed: true,
      amount: normalizedAmount,
      reason: 'ok',
      isMasterUser: false,
      modelName: meta.modelName,
      nodeRemark: meta.nodeRemark,
      detail: meta.detail,
    });
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
  appendUsageEvent(session, {
    category: 'image',
    action,
    allowed: true,
    amount: normalizedAmount,
    reason: 'ok',
    isMasterUser: false,
    modelName: meta.modelName,
    nodeRemark: meta.nodeRemark,
    detail: {
      ...(meta.detail || {}),
      limit,
      used,
    },
  });
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
  buildChatQuotaExceededMessage,
  getChatUsageUserStats,
  checkImageQuota,
  recordImageQuotaUsage,
  buildImageQuotaExceededMessage,
  buildImageQuotaUsageNotice,
  getImageUsageUserStats,
};
