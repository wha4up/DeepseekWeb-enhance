// ==UserScript==
// @name         DS MCP Bridge
// @namespace    https://github.com/calendar0917/ds-enhance
// @version      2.0.0
// @description  让 DeepSeek Chat 调用本地 MCP 工具（Shell、搜索等）
// @author       ds-enhance
// @match        https://chat.deepseek.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_PREFIX = '[Bridge]';
  const DEFAULT_MCP_URL = 'http://localhost:8024/mcp';
  const TOOL_CALL_RE = /```mcp:(\w+)\n([\s\S]*?)```/g;

  // ═══════════════════════════════════════════════════════════════
  //  MCP Client (GM_xmlhttpRequest to bypass CORS)
  // ═══════════════════════════════════════════════════════════════
  class MCPClient {
    constructor(url) {
      this.url = url;
      this.sessionId = null;
      this._nextId = 1;
      this.connected = false;
    }

    _post(body) {
      return new Promise((resolve, reject) => {
        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        };
        if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
        GM_xmlhttpRequest({
          method: 'POST', url: this.url, headers,
          data: JSON.stringify(body),
          onload: (resp) => {
            try {
              const text = resp.responseText;
              if (resp.responseHeaders?.includes('text/event-stream')) {
                for (const line of text.split('\n')) {
                  if (line.startsWith('data: ')) { resolve(JSON.parse(line.slice(6))); return; }
                }
                reject(new Error('No data in SSE response'));
              } else {
                resolve(JSON.parse(text));
              }
            } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
          },
          onerror: (e) => reject(new Error(`Network error: ${e.error || 'connection refused'}`)),
          ontimeout: () => reject(new Error('Request timed out')),
          timeout: 30000,
        });
      });
    }

    async _rpc(method, params = {}) {
      const id = this._nextId++;
      const resp = await this._post({ jsonrpc: '2.0', id, method, params });
      if (resp.error) throw new Error(`MCP error: ${resp.error.message}`);
      return resp.result;
    }

    async initialize() {
      try {
        const result = await this._rpc('initialize', {
          protocolVersion: '2025-03-26', capabilities: {},
          clientInfo: { name: 'ds-mcp-bridge', version: '2.0.0' },
        });
        this.sessionId = result.sessionId;
        this.connected = true;
        await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' });
        console.log(`${SCRIPT_PREFIX} MCP connected: ${this.sessionId}`);
        return true;
      } catch (e) { console.error(`${SCRIPT_PREFIX} Init failed:`, e.message); this.connected = false; return false; }
    }

    async listTools() {
      if (!this.connected) await this.initialize();
      const result = await this._rpc('tools/list');
      return result.tools || [];
    }

    async callTool(name, args = {}) {
      if (!this.connected) await this.initialize();
      return this._rpc('tools/call', { name, arguments: args });
    }

    async checkHealth() {
      try {
        const resp = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET', url: this.url.replace('/mcp', '/health'),
            onload: (r) => resolve(JSON.parse(r.responseText)),
            onerror: (e) => reject(e), timeout: 5000,
          });
        });
        return resp.status === 'ok';
      } catch { return false; }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Tool Registry & Hint Builder
  // ═══════════════════════════════════════════════════════════════
  let toolRegistry = [];

  function buildToolHint() {
    if (!toolRegistry.length) return '';
    let hint = '[系统指令] 你拥有以下 MCP 工具。当用户的需求可以用工具完成时，你必须在回复中调用工具。';
    hint += ' 调用格式：用代码块写 ```mcp:工具名``` 后紧跟一个 JSON 代码块写参数。\n\n';
    hint += '示例：\n```mcp:execute_command\n{"command": "ls -la"}\n```\n\n';
    hint += '可用工具列表：\n';
    toolRegistry.forEach(t => {
      hint += `- ${t.name}: ${t.description || ''}`;
      const req = t.inputSchema?.required;
      if (req?.length) hint += ` (参数: ${req.join(', ')})`;
      hint += '\n';
    });
    hint += '\n如果不需要工具就正常回答。需要工具时一定要调用。';
    hint += '\n\n当收到用户发送的 <tool_result> 包裹的文本时，这是你之前调用的工具的执行结果。请基于结果继续回答用户的问题。';
    return hint;
  }

  function injectHint(bodyStr) {
    if (!toolRegistry.length || !bodyStr) return bodyStr;
    try {
      const parsed = JSON.parse(bodyStr);
      const hint = buildToolHint();
      let injected = false;

      if (parsed.prompt && typeof parsed.prompt === 'string' && !parsed.prompt.includes('[系统指令] 你拥有以下 MCP 工具')) {
        parsed.prompt = hint + '\n\n' + parsed.prompt;
        injected = true;
      }
      if (!injected && parsed.messages?.length) {
        const lastMsg = parsed.messages[parsed.messages.length - 1];
        const content = lastMsg?.content;
        if (typeof content === 'string' && !content.includes('[系统指令] 你拥有以下 MCP 工具')) {
          lastMsg.content = hint + '\n\n' + content;
          injected = true;
        } else if (Array.isArray(content)) {
          const textPart = content.find(p => p.type === 'text');
          if (textPart && !textPart.text.includes('[系统指令]')) {
            textPart.text = hint + '\n\n' + textPart.text;
            injected = true;
          }
        }
      }

      if (injected) { console.log(`${SCRIPT_PREFIX} Tool hint injected`); return JSON.stringify(parsed); }
    } catch { /* not JSON */ }
    return bodyStr;
  }

  // ═══════════════════════════════════════════════════════════════
  //  SSE Parsing — DeepSeek native format + OpenAI compatible
  // ═══════════════════════════════════════════════════════════════
  const executedCalls = new Set();
  let _streamDebounce = null;

  function checkForToolCalls(content) {
    if (!content || !toolRegistry.length) return;

    // Strategy 1: Match ```mcp:tool_name\n{...}\n```
    const re = new RegExp(TOOL_CALL_RE.source, 'g');
    let match;
    while ((match = re.exec(content)) !== null) {
      const toolName = match[1];
      const rawArgs = match[2].trim();
      let args = {};
      try { args = JSON.parse(rawArgs); }
      catch { args = { input: rawArgs }; }

      const key = toolName + ':' + JSON.stringify(args);
      if (executedCalls.has(key)) continue;
      executedCalls.add(key);

      console.log(`${SCRIPT_PREFIX} Tool call: ${toolName}`, args);
      executeToolCall(toolName, args);
    }

    // Strategy 2: Match registered tool names directly
    // Handles SSE token boundary truncation
    for (const tool of toolRegistry) {
      const name = tool.name;
      const idx = content.indexOf(name);
      if (idx === -1) continue;

      const afterName = content.substring(idx + name.length);
      const braceStart = afterName.indexOf('{');
      if (braceStart === -1) continue;

      const braceEnd = afterName.indexOf('}', braceStart);
      if (braceEnd === -1) continue;

      const jsonStr = afterName.substring(braceStart, braceEnd + 1);
      let args = {};
      try { args = JSON.parse(jsonStr); }
      catch { args = { input: jsonStr }; }

      const key = name + ':' + JSON.stringify(args);
      if (executedCalls.has(key)) continue;
      executedCalls.add(key);

      console.log(`${SCRIPT_PREFIX} Tool call: ${name}`, args);
      executeToolCall(name, args);
    }
  }

  function parseSSEChunk(rawText) {
    let content = '';
    const lines = rawText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const jsonStr = trimmed.slice(6).trim();
      if (jsonStr === '[DONE]') continue;

      try {
        const obj = JSON.parse(jsonStr);

        // DeepSeek native: {"p":"response/content","o":"SET","v":"text"}
        const v = obj.v;
        if (typeof v === 'string' && v.length > 0) {
          const p = obj.p || '';
          if (!p.includes('fragments') && !p.includes('status')) {
            content += v;
          }
          continue;
        }

        // OpenAI streaming: choices[0].delta.content
        const c = obj?.choices?.[0]?.delta?.content;
        if (c) { content += c; continue; }

        // OpenAI non-streaming: choices[0].message.content
        const mc = obj?.choices?.[0]?.message?.content;
        if (mc) { content += mc; continue; }

      } catch { /* not JSON, skip */ }
    }

    return content;
  }

  // ═══════════════════════════════════════════════════════════════
  //  XHR Hook — SSE stream reading via progress events
  // ═══════════════════════════════════════════════════════════════
  const XHRProto = unsafeWindow.XMLHttpRequest.prototype;
  const origOpen = XHRProto.open;
  const origSend = XHRProto.send;
  const xhrMeta = new WeakMap();

  XHRProto.open = function (method, url, ...rest) {
    xhrMeta.set(this, { url, method });
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XHRProto.send = function (body) {
    const meta = xhrMeta.get(this);
    if (!meta) return origSend.apply(this, [body]);

    const isCompletion = meta.url.includes('completion');
    if (isCompletion) {
      if (body && toolRegistry.length) body = injectHint(body);

      let requestContent = '';
      let requestLastLen = 0;

      this.addEventListener('progress', function () {
        try {
          const rt = this.responseText || '';
          if (rt.length <= requestLastLen) return;
          requestLastLen = rt.length;
          requestContent = parseSSEChunk(rt);

          if (_streamDebounce) clearTimeout(_streamDebounce);
          _streamDebounce = setTimeout(() => {
            if (requestContent) checkForToolCalls(requestContent);
          }, 1000);
        } catch { /* ignore */ }
      });

      this.addEventListener('load', function () {
        try {
          const rt = this.responseText || '';
          if (rt) requestContent = parseSSEChunk(rt);
        } catch { /* ignore */ }
        if (_streamDebounce) clearTimeout(_streamDebounce);
        checkForToolCalls(requestContent);
      });
    }

    return origSend.apply(this, [body]);
  };

  // ── Hook fetch (backup) ──
  const origFetch = unsafeWindow.fetch;

  unsafeWindow.fetch = async function (...args) {
    const url = (typeof args[0] === 'string') ? args[0] : args[0]?.url;

    if (url && url.includes('completion')) {
      if (args[1]?.body && toolRegistry.length) {
        args[1].body = injectHint(args[1].body);
      }

      const response = await origFetch.apply(this, args);
      const contentType = response.headers?.get('content-type') || '';

      const clone = response.clone();
      clone.text().then(text => {
        const content = parseSSEChunk(text);
        if (content) checkForToolCalls(content);
      }).catch(() => {});

      return response;
    }

    return origFetch.apply(this, args);
  };

  // ═══════════════════════════════════════════════════════════════
  //  Tool Execution & Result Injection
  // ═══════════════════════════════════════════════════════════════
  async function executeToolCall(toolName, args) {
    const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
    const client = new MCPClient(mcpUrl);

    try {
      toast(`调用工具: ${toolName}...`, 'info');
      const result = await client.callTool(toolName, args);
      const resultText = result?.content?.[0]?.text || '(no result)';
      const isError = result?.isError;

      toast(isError ? `${toolName} 失败` : `${toolName} 完成`, isError ? 'error' : 'success');
      injectResultToChat(isError ? `Error: ${resultText}` : resultText);
    } catch (e) {
      toast(`工具调用失败: ${e.message}`, 'error');
      console.error(`${SCRIPT_PREFIX} Tool error:`, e);
      injectResultToChat(`Error: ${e.message}`);
    }
  }

  function injectResultToChat(resultText) {
    setTimeout(async () => {
      const wrappedText = `<tool_result>\n${resultText}\n</tool_result>`;

      const input = findInputElement();
      if (!input) {
        toast('找不到聊天输入框', 'error');
        return;
      }

      input.focus();
      await sleep(200);
      setInputValue(input, wrappedText);
      await sleep(500);
      simulateEnter(input);
      await sleep(300);

      // Fallback: click send button
      const sendBtn = findSendButton();
      if (sendBtn) sendBtn.click();

      toast('工具结果已发送', 'success');
    }, 1500);
  }

  function findInputElement() {
    for (const ta of document.querySelectorAll('textarea')) {
      if (isVisible(ta)) return ta;
    }
    const editables = document.querySelectorAll('[contenteditable="true"]');
    for (const el of editables) {
      if (isVisible(el) && el.getAttribute('placeholder')) return el;
    }
    for (const el of editables) {
      if (isVisible(el)) return el;
    }
    return null;
  }

  function findSendButton() {
    const selectors = [
      'button[aria-label*="send"]', 'button[aria-label*="Send"]',
      'button[aria-label*="发送"]', 'button[aria-label*="Submit"]',
      'button[type="submit"]', 'div[role="button"][aria-label*="send"]',
      'div[role="button"][aria-label*="发送"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && isVisible(btn)) return btn;
    }
    return null;
  }

  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function setInputValue(element, value) {
    const isCE = element.contentEditable === 'true';

    if (isCE) {
      element.focus();
      const sel = unsafeWindow.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      sel.removeAllRanges();
      sel.addRange(range);

      element.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: value,
      }));

      try { document.execCommand('insertText', false, value); }
      catch { element.textContent = value; }

      range.selectNodeContents(element);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      const setter = Object.getOwnPropertyDescriptor(
        unsafeWindow.HTMLTextAreaElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        unsafeWindow.HTMLInputElement.prototype, 'value'
      )?.set;

      if (setter) setter.call(element, value);
      else element.value = value;
    }

    [
      new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }),
      new Event('change', { bubbles: true }),
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Unidentified' }),
      new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Unidentified' }),
    ].forEach(e => element.dispatchEvent(e));
  }

  function simulateEnter(element) {
    const init = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    };
    element.dispatchEvent(new KeyboardEvent('keydown', init));
    element.dispatchEvent(new KeyboardEvent('keypress', init));
    element.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ═══════════════════════════════════════════════════════════════
  //  Toast
  // ═══════════════════════════════════════════════════════════════
  function toast(msg, type = 'info') {
    if (!document.body) return;
    const colors = { info: '#2a2a3e', success: '#0d3320', error: '#3d0f0f' };
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:1000001;background:${colors[type]};color:#eee;padding:12px 22px;border-radius:10px;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,.5);font-family:system-ui;transition:opacity .3s;`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Auto-connect on page ready
  // ═══════════════════════════════════════════════════════════════
  function waitForDOM() {
    return new Promise(resolve => {
      if (document.body) resolve();
      else new MutationObserver(() => { if (document.body) resolve(); })
        .observe(document.documentElement, { childList: true });
    });
  }

  waitForDOM().then(async () => {
    const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
    const client = new MCPClient(mcpUrl);
    const healthy = await client.checkHealth();
    if (!healthy) {
      console.log(`${SCRIPT_PREFIX} MCP server not running, tool calls disabled`);
      return;
    }
    const tools = await client.listTools();
    toolRegistry = tools;
    console.log(`${SCRIPT_PREFIX} v2.0.0 ready — ${tools.length} tools registered`);
  });
})();
