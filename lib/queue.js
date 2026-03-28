/**
 * queue.js — 请求队列与并发控制
 * 限制同时进行的 API 请求数量，防止高峰期雪崩
 */

const state = require('./state');
const logger = require('./logger');

function normalizeQueueNumber(value, fallback, minimum = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(minimum, Math.floor(num));
}

function getQueueConfig() {
  const cfg = state.runtimeConfig.requestQueue || {};
  return {
    maxConcurrent: normalizeQueueNumber(cfg.maxConcurrent, 3, 1),
    maxPending: normalizeQueueNumber(cfg.maxPending, 10, 0),
    overflowText: String(cfg.overflowText || 'NEKOAI请求队列已达上限，当前前方有{ahead}个请求未完成。请稍后重试。').trim() || 'NEKOAI请求队列已达上限，当前前方有{ahead}个请求未完成。请稍后重试。',
  };
}

function getQueueSnapshot() {
  const { maxConcurrent, maxPending, overflowText } = getQueueConfig();
  const running = state.queueState.running;
  const pending = state.queueState.queue.length;
  const availableSlots = Math.max(0, maxConcurrent - running);
  const willQueue = availableSlots <= pending;
  const ahead = running + pending;
  const overflow = maxPending > 0 && pending >= maxPending;

  return {
    running,
    pending,
    maxConcurrent,
    maxPending,
    availableSlots,
    willQueue,
    ahead,
    overflow,
    overflowText,
  };
}

function applyQueueTextTemplate(template, snapshot) {
  return String(template || '')
    .replace(/\{ahead\}/g, String(snapshot.ahead))
    .replace(/\{running\}/g, String(snapshot.running))
    .replace(/\{pending\}/g, String(snapshot.pending))
    .replace(/\{maxConcurrent\}/g, String(snapshot.maxConcurrent))
    .replace(/\{maxPending\}/g, String(snapshot.maxPending));
}

function buildQueueOverflowText(snapshot) {
  return applyQueueTextTemplate(snapshot.overflowText, snapshot);
}

class QueueOverflowError extends Error {
  constructor(snapshot) {
    super(buildQueueOverflowText(snapshot));
    this.name = 'QueueOverflowError';
    this.code = 'QUEUE_OVERFLOW';
    this.snapshot = snapshot;
  }
}

/**
 * 将一个异步任务加入队列，等待空位后执行
 * @param {Function} asyncFn - 返回 Promise 的异步函数
 * @returns {Promise} - asyncFn 的返回值
 */
function enqueue(asyncFn) {
  const snapshot = getQueueSnapshot();
  if (snapshot.overflow) {
    logger.warn(`请求队列已达上限，拒绝入队。运行中: ${snapshot.running}/${snapshot.maxConcurrent}，排队: ${snapshot.pending}/${snapshot.maxPending}`);
    return Promise.reject(new QueueOverflowError(snapshot));
  }

  return new Promise((resolve, reject) => {
    state.queueState.queue.push({ fn: asyncFn, resolve, reject });
    const queuedSnapshot = getQueueSnapshot();
    logger.debug(`请求入队，队列长度: ${queuedSnapshot.pending}，运行中: ${queuedSnapshot.running}/${queuedSnapshot.maxConcurrent}${queuedSnapshot.maxPending > 0 ? `，排队上限: ${queuedSnapshot.maxPending}` : ''}`);
    processQueue();
  });
}

function processQueue() {
  while (state.queueState.running < getQueueConfig().maxConcurrent && state.queueState.queue.length > 0) {
    const { fn, resolve, reject } = state.queueState.queue.shift();
    state.queueState.running++;
    const snapshot = getQueueSnapshot();
    logger.debug(`请求出队开始执行，运行中: ${state.queueState.running}/${snapshot.maxConcurrent}，剩余排队: ${state.queueState.queue.length}`);
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        state.queueState.running--;
        processQueue();
      });
  }
}

module.exports = { enqueue, getQueueSnapshot, buildQueueOverflowText, QueueOverflowError };
