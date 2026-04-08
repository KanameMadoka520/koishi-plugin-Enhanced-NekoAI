/**
 * usage-events.js — 统一用量事件日志
 */

const state = require('./state');
const logger = require('./logger');
const { getPeriodInfo } = require('./utils');
const { saveUsageEvents } = require('./config');

const USAGE_EVENT_SCHEMA_VERSION = 1;
const MAX_USAGE_EVENTS = 10000;

function normalizeUsageEventAmount(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.floor(value));
}

function ensureUsageEventStore() {
  if (!state.usageEventData || typeof state.usageEventData !== 'object' || Array.isArray(state.usageEventData)) {
    state.usageEventData = { schemaVersion: USAGE_EVENT_SCHEMA_VERSION, events: [] };
  }
  if (!Array.isArray(state.usageEventData.events)) {
    state.usageEventData.events = [];
  }
  if (!Number.isInteger(Number(state.usageEventData.schemaVersion))) {
    state.usageEventData.schemaVersion = USAGE_EVENT_SCHEMA_VERSION;
  }
  return state.usageEventData;
}

function appendUsageEvent(session, payload = {}) {
  try {
    const store = ensureUsageEventStore();
    const userId = String(payload.userId ?? session?.userId ?? '').trim();
    const isDirect = payload.scope
      ? payload.scope === 'private'
      : !!session?.isDirect;
    const channelIdRaw = payload.channelId ?? session?.channelId ?? '';
    const channelId = isDirect ? null : (String(channelIdRaw || '').trim() || null);
    const event = {
      id: `usage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      periodId: String(payload.periodId || getPeriodInfo()),
      category: payload.category === 'image' ? 'image' : 'chat',
      action: String(payload.action || 'chat'),
      allowed: payload.allowed !== false,
      amount: normalizeUsageEventAmount(payload.amount),
      userId,
      channelId,
      scope: isDirect ? 'private' : 'group',
      reason: String(payload.reason || 'ok'),
      isMasterUser: payload.isMasterUser === true,
      modelName: String(payload.modelName || '').trim() || undefined,
      nodeRemark: String(payload.nodeRemark || '').trim() || undefined,
      detail: payload.detail && typeof payload.detail === 'object' && !Array.isArray(payload.detail)
        ? payload.detail
        : undefined,
    };

    store.events.push(event);
    if (store.events.length > MAX_USAGE_EVENTS) {
      store.events.splice(0, store.events.length - MAX_USAGE_EVENTS);
    }
    saveUsageEvents();
    return event;
  } catch (error) {
    logger.warn(`写入 usage_events.json 失败: ${error?.message || '未知错误'}`);
    return null;
  }
}

module.exports = {
  USAGE_EVENT_SCHEMA_VERSION,
  MAX_USAGE_EVENTS,
  ensureUsageEventStore,
  appendUsageEvent,
};
