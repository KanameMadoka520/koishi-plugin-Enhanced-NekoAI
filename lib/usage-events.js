/**
 * usage-events.js — 统一用量事件日志
 */

const state = require('./state');
const logger = require('./logger');
const { getPeriodInfo } = require('./utils');

const USAGE_EVENT_SCHEMA_VERSION = 1;
const MAX_USAGE_EVENTS = 10000;

function normalizeUsageEventAmount(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.floor(value));
}

function buildUsageEventId(prefix = 'usage') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeUsageEventRecord(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { event: null, changed: false };
  }

  const userId = String(raw.userId ?? '').trim();
  const timestamp = String(raw.timestamp ?? '').trim();
  if (!userId || !timestamp) {
    return { event: null, changed: false };
  }

  const rawId = String(raw.id ?? '').trim();
  const rawPeriodId = String(raw.periodId ?? '').trim();
  const rawAction = String(raw.action ?? 'chat').trim();
  const rawReason = String(raw.reason ?? 'ok').trim();
  const rawModelName = String(raw.modelName ?? '').trim();
  const rawNodeRemark = String(raw.nodeRemark ?? '').trim();
  const rawDetail = raw.detail && typeof raw.detail === 'object' && !Array.isArray(raw.detail)
    ? raw.detail
    : undefined;
  const scope = raw.scope === 'private' ? 'private' : 'group';
  const channelId = scope === 'private'
    ? null
    : (raw.channelId == null ? null : (String(raw.channelId).trim() || null));

  const event = {
    id: rawId || `usage_legacy_${index + 1}`,
    timestamp,
    periodId: rawPeriodId || getPeriodInfo(),
    category: raw.category === 'image' ? 'image' : 'chat',
    action: rawAction || 'chat',
    allowed: raw.allowed !== false,
    amount: normalizeUsageEventAmount(raw.amount),
    userId,
    channelId,
    scope,
    reason: rawReason || 'ok',
    isMasterUser: raw.isMasterUser === true,
    modelName: rawModelName || undefined,
    nodeRemark: rawNodeRemark || undefined,
    detail: rawDetail,
  };

  const rawAmount = Number(raw.amount);
  const changed =
    !rawId ||
    !rawPeriodId ||
    !rawAction ||
    !rawReason ||
    !Number.isFinite(rawAmount) ||
    rawAmount <= 0 ||
    Math.floor(rawAmount) !== event.amount ||
    rawModelName !== (event.modelName || '') ||
    rawNodeRemark !== (event.nodeRemark || '') ||
    (scope === 'private' && raw.channelId != null) ||
    (scope !== 'private' && channelId !== (raw.channelId == null ? null : (String(raw.channelId).trim() || null))) ||
    (!!rawDetail !== !!event.detail);

  return { event, changed };
}

function sanitizeUsageEventStore(raw) {
  const rawEvents = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.events) ? raw.events : []);
  const events = [];
  let droppedCount = 0;
  let normalizedCount = 0;

  rawEvents.forEach((item, index) => {
    const { event, changed } = normalizeUsageEventRecord(item, index);
    if (!event) {
      droppedCount += 1;
      return;
    }
    events.push(event);
    if (changed) normalizedCount += 1;
  });

  let prunedCount = 0;
  if (events.length > MAX_USAGE_EVENTS) {
    prunedCount = events.length - MAX_USAGE_EVENTS;
    events.splice(0, prunedCount);
  }

  const changed =
    Array.isArray(raw) ||
    !raw ||
    typeof raw !== 'object' ||
    !Array.isArray(raw?.events) ||
    Number(raw?.schemaVersion) !== USAGE_EVENT_SCHEMA_VERSION ||
    droppedCount > 0 ||
    normalizedCount > 0 ||
    prunedCount > 0;

  return {
    store: {
      schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
      events,
    },
    changed,
    droppedCount,
    normalizedCount,
    prunedCount,
  };
}

function ensureUsageEventStore() {
  const { store } = sanitizeUsageEventStore(state.usageEventData);
  state.usageEventData = store;
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
      id: buildUsageEventId('usage'),
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
    const { saveUsageEvents } = require('./config');
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
  sanitizeUsageEventStore,
  ensureUsageEventStore,
  appendUsageEvent,
};
