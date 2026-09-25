'use strict';
// Redact only identifying data. Never classify, translate or summarize upstream errors.
function redactForChat(value, nodes = []) {
  let text = String(value ?? '');
  const secrets = new Map();
  const add = (value, replacement) => {
    if (typeof value === 'string' && value.trim()) secrets.set(value, replacement);
  };
  function visit(value, key = '') {
    if (Array.isArray(value)) { value.forEach(item => visit(item, key)); return; }
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([k, v]) => visit(v, k)); return;
    }
    if (typeof value !== 'string') return;
    if (/remark/i.test(key)) add(value, '[节点备注已隐藏]');
    if (/apiKey|token|secret/i.test(key)) add(value, '[密钥已隐藏]');
    if (/url|endpoint/i.test(key)) {
      add(value, '[网址已隐藏]');
      try { add(new URL(value).hostname, '[站点已隐藏]'); } catch {}
    }
  }
  nodes.forEach(node => visit(node));
  // Match longest values first, in one pass, so replacements cannot redact one another.
  if (secrets.size) {
    const escape = s => s.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
    const values = [...secrets.keys()].sort((a, b) => b.length - a.length);
    text = text.replace(new RegExp(values.map(escape).join('|'), 'g'), match => secrets.get(match));
  }
  return text
    .replace(/\b(?:https?|wss?|ftp):(?:\/\/|\\\/\\\/)[^\s<>"'\x60，。；！？）】]+/gi, '[网址已隐藏]')
    .replace(/\b(?:https?|wss?)%3a(?:%2f){2}[^\s<>"'\x60，。；！？）】]+/gi, '[网址已隐藏]')
    .replace(/(?:\/\/)?\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d+)?(?:\/[^\s<>"'\x60，。；！？）】]*)?/gi, '[站点已隐藏]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/[^\s<>"'\x60，。；！？）】]*)?/g, '[站点已隐藏]')
    .replace(/\[[0-9a-f]*:[0-9a-f:]+\](?::\d+)?/gi, '[站点已隐藏]')
    .replace(/\bBearer\s+[a-z0-9._~+\/-]+/gi, 'Bearer [密钥已隐藏]')
    .replace(/\bsk-[a-z0-9_-]+/gi, '[密钥已隐藏]');
}
function rawErrorText(error) {
  if (typeof error === 'string') return error;
  if (!error) return 'Unknown error';
  const parts = [];
  const status = error.response?.status || error.status;
  if (status) parts.push('HTTP ' + status);
  if (error.code) parts.push(String(error.code));
  if (error.message) parts.push(String(error.message));
  const data = error.response?.data;
  const detail = typeof data === 'string' ? data : data?.error?.message || data?.message;
  if (detail && !parts.includes(String(detail))) parts.push(String(detail));
  if (error.cause?.message && !parts.includes(error.cause.message)) parts.push(error.cause.message);
  return parts.join('\n') || 'Unknown error';
}
module.exports = { redactForChat, rawErrorText };
