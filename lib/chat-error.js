'use strict';
// Chat output is constructed from fixed categories, never from an upstream error body.
function safeModelName(value) {
  const model = String(value || '').trim();
  if (!model || model.length > 120 || !/^[a-zA-Z0-9_./:@+-]+$/.test(model)
    || /:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:]|$)|sk-/i.test(model)
    || /(?:\d{1,3}\.){3}\d{1,3}|localhost/i.test(model)
    || model.includes('@') || model.includes(':')) return '未知模型';
  return model;
}
function errorType(error) {
  const status = Number(error?.response?.status || error?.status || error?.statusCode);
  if (status === 401) return '身份验证失败（HTTP 401）';
  if (status === 403) return '访问被拒绝（HTTP 403）';
  if (status === 429) return '请求限流或额度不足（HTTP 429）';
  if (status >= 500 && status <= 599) return '上游服务错误（HTTP ' + status + '）';
  if (status >= 400 && status <= 499) return '请求错误（HTTP ' + status + '）';
  const text = String(error?.code || '') + ' ' + String(error?.message || error || '');
  if (/timeout|timed? ?out|ETIMEDOUT|超时/i.test(text)) return '请求超时';
  if (/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket|network|网络/i.test(text)) return '网络连接失败';
  if (/quota|rate.limit|限流|额度/i.test(text)) return '请求限流或额度不足';
  if (/API Key|未配置|没有可尝试/i.test(text)) return '配置错误';
  if (/缺少可用文本|为空|JSON|非 SSE|parse/i.test(text)) return '响应格式错误';
  return '调用失败';
}
function formatCallFailure(error, model) {
  return '错误类型：' + errorType(error) + '\n模型：' + safeModelName(model);
}
module.exports = { safeModelName, errorType, formatCallFailure };
