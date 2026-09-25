const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { redactForChat, rawErrorText } = require('../lib/chat-error');
const nodes = [{ remark: '站点甲(vip)+', apiUrl: 'https://private.example/v1', apiKey: 'secret-token', modelName: 'gpt-4.1' }, { remark: '站点乙', modelName: 'gpt-image-2' }];
test('原始英文、换行、状态码和模型保留，只隐藏来源', () => {
 const text = '节点 #2 站点甲(vip)+ · gpt-4.1\nHTTP 429: Too Many Requests\nRequest failed at https://private.example/v1';
 assert.equal(redactForChat(text, nodes), '节点 #2 [节点备注已隐藏] · gpt-4.1\nHTTP 429: Too Many Requests\nRequest failed at [网址已隐藏]');
});
test('网址、裸域名、IPv4/IPv6 和密钥不泄露', () => {
 for (const text of ['https://other.example/path?token=abc', 'http:\\/\\/other.example/path', 'https%3A%2F%2Fother.example%2Fpath', '//other.example/path', 'other.example:8080', '192.0.2.1:443', '[2001:db8::1]:443', 'Bearer secret-token', 'sk-test-key']) {
   const output = redactForChat(text, nodes);
   assert.doesNotMatch(output, /other\.example|192\.0\.2\.1|2001:db8|secret-token|sk-test-key|https?:/i);
 }
});
test('不翻译不截断普通错误，也不破坏模型名称', () => {
 const text = 'ECONNRESET socket hang up\nInvalid image size: 1024x1024\n' + 'upstream detail '.repeat(80);
 assert.equal(redactForChat(text, nodes), text);
 for (const model of ['gpt-4.1', 'gemini-2.5-pro', 'provider/claude-sonnet-4-5']) assert.equal(redactForChat(model, nodes), model);
});
test('读取原始错误和响应正文，不用固定中文类型替换', () => {
 const result = rawErrorText({ code: 'ETIMEDOUT', message: 'Request timed out', response: { status: 504, data: { error: { message: 'Gateway Timeout' } } } });
 assert.equal(result, 'HTTP 504\nETIMEDOUT\nRequest timed out\nGateway Timeout');
});
test('实际聊天出口保留英文并脱敏自定义尾部文本', () => {
 const source = fs.readFileSync(require.resolve('../lib/listener'), 'utf8');
 const body = source.slice(source.indexOf('function buildGenerationFailedMessage('), source.indexOf('async function sendAiResultToChat'));
 const context = { redactForChat, rawErrorText, state: { apiList: nodes }, getFailureNoticeConfig: () => ({ enabled: true, retryText: '请重试 https://private.example/v1' }) };
 vm.createContext(context); vm.runInContext(body, context);
 const result = context.buildGenerationFailedMessage({ error: { response: { status: 401 }, message: 'Unauthorized: Invalid API key at https://private.example/v1' }, apiInfo: { nodeIndex: 2, remark: nodes[0].remark, modelName: 'gpt-4.1' } });
 assert.match(result, /节点 #2 · gpt-4\.1/);
 assert.match(result, /HTTP 401\nUnauthorized: Invalid API key at \[网址已隐藏\]/);
 assert.doesNotMatch(result, /private\.example|站点甲/);
 context.getFailureNoticeConfig = () => ({ enabled: false });
 assert.equal(context.buildGenerationFailedMessage({}), '');
});
test('实际图像路由恢复完整失败路径与各节点原始英文', async () => {
 const source = fs.readFileSync(require.resolve('../lib/commands'), 'utf8');
 const formatter = source.slice(source.indexOf('function buildImageRouteFailureMessage('), source.indexOf('function filterSendableGeneratedImages('));
 const body = source.slice(source.indexOf('async function generateImagesWithRoute('), source.indexOf('async function collectXaiEditImages('));
 const context = { cloneImageRouteOptions: x => x, buildImageNodeLabel: (n, i) => '#' + i + ' ' + n.remark, getDefaultImageModelName: () => 'default', logger: { info() {}, warn() {} }, generateImages: async (ctx, node) => { throw new Error(node.modelName === 'gpt-4.1' ? 'HTTP 429: Too Many Requests at https://private.example/v1' : 'HTTP 503: Service Unavailable'); } };
 vm.createContext(context); vm.runInContext(formatter + body, context);
 await assert.rejects(context.generateImagesWithRoute({}, { route: nodes.map((apiNode, index) => ({ apiNode, index })) }, 'hello'), error => {
   const output = redactForChat(error.message, nodes);
   assert.match(output, /图像路由集群全部 2 个节点均失败/);
   assert.match(output, /失败路径：#0 \[节点备注已隐藏\] · gpt-4\.1: HTTP 429: Too Many Requests/);
   assert.match(output, /#1 \[节点备注已隐藏\] · gpt-image-2: HTTP 503: Service Unavailable/);
   assert.doesNotMatch(output, /private\.example|站点甲|站点乙/);
   return true;
 });
});
test('实际图像发送边界脱敏，保留连续生成进度', async () => {
 const source = fs.readFileSync(require.resolve('../lib/commands'), 'utf8');
 const body = source.slice(source.indexOf('async function sendAutoRecallImageNotice('), source.indexOf('function canUseImageCommand('));
 const context = { redactForChat, state: { imageApiList: nodes }, IMAGE_NOTICE_RECALL_MS: 30000, scheduleImageNoticeRecall() {} };
 vm.createContext(context); vm.runInContext(body, context);
 let sent;
 await context.sendAutoRecallImageNotice({ send: async text => { sent = text; return ['1']; } }, '连续生图中断：已成功生成 2/3 张\n失败路径：#2 站点乙: HTTP 503 Service Unavailable https://private.example/v1');
 assert.match(sent, /已成功生成 2\/3 张/);
 assert.match(sent, /HTTP 503 Service Unavailable/);
 assert.doesNotMatch(sent, /站点乙|private\.example/);
});
