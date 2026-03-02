/**
 * utils.js — 通用工具函数
 */

const fs = require('fs');
const path = require('path');
const state = require('./state');

function formattedDateTime() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

// 基于东八区的12小时段标识 (06:00-18:00 为 Day，18:00-06:00 为 Night)
function getPeriodInfo() {
  const now = new Date();
  const utc8Date = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (8 * 3600000));
  const y = utc8Date.getFullYear();
  const m = String(utc8Date.getMonth() + 1).padStart(2, '0');
  const d = String(utc8Date.getDate()).padStart(2, '0');
  const h = utc8Date.getHours();

  if (h >= 6 && h < 18) {
    return `${y}-${m}-${d}_Day`;
  } else {
    let nightDate = utc8Date;
    if (h < 6) nightDate = new Date(utc8Date.getTime() - 24 * 3600 * 1000);
    const ny = nightDate.getFullYear();
    const nm = String(nightDate.getMonth() + 1).padStart(2, '0');
    const nd = String(nightDate.getDate()).padStart(2, '0');
    return `${ny}-${nm}-${nd}_Night`;
  }
}

function isMaster(session) {
  if (!state.runtimeConfig.masterQQ || !Array.isArray(state.runtimeConfig.masterQQ)) return false;
  return state.runtimeConfig.masterQQ.includes(session.userId);
}

function isBlacklisted(userId) {
  return (state.runtimeConfig.userBlacklist || []).includes(userId);
}

function isKoishiCommand(content) {
  if (!content) return false;
  const lowerContent = content.trim().toLowerCase();
  for (const rawCmd of state.blacklistCommands) {
    if (typeof rawCmd !== 'string') continue;
    const cmd = rawCmd.toLowerCase();
    if (lowerContent === cmd || lowerContent.startsWith(cmd + " ")) return true;
  }
  return false;
}

function loadCommandsList() {
  const filePath = path.join(__dirname, '..', 'commands.json');
  if (fs.existsSync(filePath)) {
    try {
      state.blacklistCommands = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!Array.isArray(state.blacklistCommands)) state.blacklistCommands = [];
    } catch (e) { state.blacklistCommands = []; }
  } else { state.blacklistCommands = []; }
}

// 群名单管理
async function updateGroupFriends(ctx) {
  const logger = require('./logger');
  try {
    const bot = ctx.bots.find(b => b.platform === 'onebot') || ctx.bots[0];
    if (!bot || !state.runtimeConfig.groups) return;
    for (const gid of state.runtimeConfig.groups) {
      const result = await bot.getGuildMemberList(gid);
      let finalMembers = Array.isArray(result) ? result : (result?.data || []);
      const uniqueIds = [...new Set(finalMembers.map(m => m.user?.id || m.userId).filter(id => id))];
      const filePath = path.join(__dirname, '..', `groupfriends_${gid}.json`);
      fs.writeFileSync(filePath, JSON.stringify(uniqueIds, null, 2), "utf-8");
      state.groupFriendsMap[gid] = uniqueIds;
      logger.info(`已更新群 ${gid} 的名单，共 ${uniqueIds.length} 人`);
    }
  } catch (e) { require('./logger').error(`扫描群友失败: ${e.message}`); }
}

function loadGroupFriends() {
  if (!state.runtimeConfig.groups) return;
  for (const gid of state.runtimeConfig.groups) {
    const filePath = path.join(__dirname, '..', `groupfriends_${gid}.json`);
    if (fs.existsSync(filePath)) {
      try { state.groupFriendsMap[gid] = JSON.parse(fs.readFileSync(filePath, "utf-8")); }
      catch (e) { state.groupFriendsMap[gid] = []; }
    } else { state.groupFriendsMap[gid] = []; }
  }
}

async function notifyInGroup(bot, uid) {
  const { h } = require('koishi');
  for (const gid of state.runtimeConfig.groups || []) {
    if (state.groupFriendsMap[gid] && state.groupFriendsMap[gid].includes(uid)) {
      try { await bot.sendMessage(gid, [h.at(uid), " 暂时无法回复您的私聊(风控/非好友)。"]); break; } catch (err) {}
    }
  }
}

async function safeReplyOrNotify(session, content) {
  try { await session.send(content); }
  catch (e) { await notifyInGroup(session.bot, session.userId); }
}

// 获取群聊当前绑定的人格索引 (支持按群独立绑定)
function getGroupPersonalityIndex(channelId) {
  const map = state.runtimeConfig.groupPersonalityMap || {};
  if (map[channelId] !== undefined) return map[channelId];
  return state.runtimeConfig.activeGroupPersonalityIndex || 0;
}

// 获取群聊当前绑定的API节点索引 (支持按群独立绑定)
function getGroupApiIndex(channelId) {
  const map = state.runtimeConfig.groupApiMap || {};
  if (map[channelId] !== undefined) return map[channelId];
  return state.runtimeConfig.activeApiIndex || 0;
}

function readFilesInDirectory(directoryPath) {
  try {
    if (!fs.existsSync(directoryPath)) return [];
    return fs.readdirSync(directoryPath).map(file => path.join(directoryPath, file)).filter(f => fs.statSync(f).isFile());
  } catch (err) { return []; }
}

module.exports = {
  formattedDateTime, getPeriodInfo, isMaster, isBlacklisted, isKoishiCommand,
  loadCommandsList, updateGroupFriends, loadGroupFriends, notifyInGroup,
  safeReplyOrNotify, getGroupPersonalityIndex, getGroupApiIndex, readFilesInDirectory
};
