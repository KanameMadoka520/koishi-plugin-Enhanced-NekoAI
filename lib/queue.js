/**
 * queue.js — 请求队列与并发控制
 * 限制同时进行的 API 请求数量，防止高峰期雪崩
 */

const state = require('./state');
const logger = require('./logger');

function getMaxConcurrent() {
  return state.runtimeConfig.requestQueue?.maxConcurrent || 3;
}

/**
 * 将一个异步任务加入队列，等待空位后执行
 * @param {Function} asyncFn - 返回 Promise 的异步函数
 * @returns {Promise} - asyncFn 的返回值
 */
function enqueue(asyncFn) {
  return new Promise((resolve, reject) => {
    state.queueState.queue.push({ fn: asyncFn, resolve, reject });
    logger.debug(`请求入队，队列长度: ${state.queueState.queue.length}，运行中: ${state.queueState.running}/${getMaxConcurrent()}`);
    processQueue();
  });
}

function processQueue() {
  while (state.queueState.running < getMaxConcurrent() && state.queueState.queue.length > 0) {
    const { fn, resolve, reject } = state.queueState.queue.shift();
    state.queueState.running++;
    logger.debug(`请求出队开始执行，运行中: ${state.queueState.running}/${getMaxConcurrent()}`);
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        state.queueState.running--;
        processQueue();
      });
  }
}

module.exports = { enqueue };
