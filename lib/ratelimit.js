/**
 * ratelimit.js — 群聊限流系统
 */

const state = require('./state');
const logger = require('./logger');
const { saveUsageCounts } = require('./config');
const { getPeriodInfo } = require('./utils');

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

module.exports = { checkAndUpdateGroupLimit };
