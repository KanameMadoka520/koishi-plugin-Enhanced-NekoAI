const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { formatCallFailure, safeModelName } = require('../lib/chat-error');
test('错误正文、节点名、URL 和密钥都不能进入聊天', () => {
  for (const message of ['secret-node https://api.example.com/v1?key=sk-secret', 'http://127.0.0.1:8080 private-node', '<img src="https://secret.example"/>', 'https%3A%2F%2Fsecret.example', 'Bearer secret-token']) {
    assert.equal(formatCallFailure(new Error(message), 'gpt-4.1'), '错误类型：调用失败\n模型：gpt-4.1');
  }
});
test('按结构化状态码分类，网络超时不回显错误', () => {
  assert.match(formatCallFailure({ response: { status: 429 }, message: 'https://secret.example' }, 'provider/model'), /请求限流或额度不足（HTTP 429）/);
  assert.match(formatCallFailure({ code: 'ETIMEDOUT' }, 'gpt-4.1'), /请求超时/);
  assert.match(formatCallFailure({ code: 'ECONNRESET' }, 'gpt-4.1'), /网络连接失败/);
});
test('模型字段中的网址、IP、标签和密钥也不允许输出', () => {
  for (const model of ['https://secret.example/x', 'secret.example/model', '127.0.0.1/model', '//localhost/x', '<b>test</b>', 'sk-secret', 'gpt https://x.test']) assert.equal(safeModelName(model), '未知模型');
  for (const model of ['gpt-4.1', 'claude-sonnet-4-5', 'provider/model', 'gemini-2.5-pro']) assert.equal(safeModelName(model), model);
});
test('实际聊天失败出口忽略原始 reply 和旧 full 详细提示设置', () => {
  const source = fs.readFileSync(require.resolve('../lib/listener'), 'utf8');
  const body = source.slice(source.indexOf('function buildGenerationFailedMessage('), source.indexOf('async function sendAiResultToChat'));
  for (const detailMode of ['full', 'brief', 'off']) {
    const context = { formatCallFailure, getFailureNoticeConfig: () => ({ enabled: true, detailMode, retryText: 'https://secret.example' }) };
    vm.createContext(context); vm.runInContext(body, context);
    assert.equal(context.buildGenerationFailedMessage({ reply: 'private-node https://secret.example', error: { response: { status: 401 } }, apiInfo: { remark: 'private-node', modelName: 'gpt-4.1' } }), '❌ 错误类型：身份验证失败（HTTP 401）\n模型：gpt-4.1');
    context.getFailureNoticeConfig = () => ({ enabled: false });
    assert.equal(context.buildGenerationFailedMessage({}), '');
  }
});

test('图像路由耗尽保留最后失败模型和状态，不暴露路由列表', async () => {
 const source = fs.readFileSync(require.resolve('../lib/commands'), 'utf8');
 const body = source.slice(source.indexOf('async function generateImagesWithRoute('), source.indexOf('async function collectXaiEditImages('));
 const context = { cloneImageRouteOptions: x => x, buildImageNodeLabel: n => n.remark, logger: { info() {}, warn() {} }, generateImages: async (ctx, node) => { throw Object.assign(new Error('https://secret.example ' + node.remark), { response: { status: 503 } }); } };
 vm.createContext(context); vm.runInContext(body, context);
 await assert.rejects(context.generateImagesWithRoute({}, { route: [{ index: 0, apiNode: { modelName: 'first', remark: 'secret-one' } }, { index: 1, apiNode: { modelName: 'last', remark: 'secret-two' } }] }, 'hello'), error => {
   assert.equal(formatCallFailure(error, error.modelName), '错误类型：上游服务错误（HTTP 503）\n模型：last'); return true;
 });
});

test('聊天路由耗尽使用最后尝试模型，保留结构化错误类型', async () => {
 const source = fs.readFileSync(require.resolve('../lib/api'), 'utf8');
 const body = source.slice(source.indexOf('async function getAiReply('), source.indexOf('module.exports ='));
 const context = {
   state: { runtimeConfig: {}, apiList: [{ modelName: 'first', remark: 'secret-one' }, { modelName: 'last', remark: 'secret-two' }] },
   getSmartRouter: () => ({ enabled: true, retryCount: 1, sameNodeRetryCount: 0, retryDelay: 0 }),
   readNonNegativeInteger: (x, fallback) => Number.isInteger(x) ? x : fallback,
   selectNextNode: () => 1, resolveAiType: () => 'openai',
   logger: { debug() {}, info() {}, warn() {}, error() {} },
   enqueue: fn => fn(), QueueOverflowError: class extends Error {},
   callApiOnce: async () => { throw Object.assign(new Error('secret-node https://private.example'), { response: { status: 503 } }); },
   extractApiErrorMessage: e => e?.message, isRetryableError: () => true,
 };
 vm.createContext(context); vm.runInContext(body, context);
 const result = await context.getAiReply({ http: {} }, ['hi'], '', []);
 assert.equal(result.apiInfo.modelName, 'last');
 assert.equal(formatCallFailure(result.error, result.apiInfo.modelName), '错误类型：上游服务错误（HTTP 503）\n模型：last');
});
