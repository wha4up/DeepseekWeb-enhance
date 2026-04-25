// ==UserScript==
// @name         DS MCP Bridge
// @namespace    https://github.com/calendar0917/ds-enhance
// @version      1.2.0
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

  // ═══════════════════════════════════════════════════════════════
  //  MCP Client (uses GM_xmlhttpRequest to bypass CORS)
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
          method: 'POST',
          url: this.url,
          headers,
          data: JSON.stringify(body),
          onload: (resp) => {
            try {
              const text = resp.responseText;
              if (resp.responseHeaders?.includes('text/event-stream')) {
                const lines = text.split('\n');
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    resolve(JSON.parse(line.slice(6)));
                    return;
                  }
                }
                reject(new Error('No data in SSE response'));
              } else {
                resolve(JSON.parse(text));
              }
            } catch (e) {
              reject(new Error(`Parse error: ${e.message}`));
            }
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
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'ds-mcp-bridge', version: '1.0.0' },
        });
        this.sessionId = result.sessionId;
        this.connected = true;
        await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' });
        console.log(`${SCRIPT_PREFIX} MCP session initialized: ${this.sessionId}`);
        return true;
      } catch (e) {
        console.error(`${SCRIPT_PREFIX} Init failed:`, e.message);
        this.connected = false;
        return false;
      }
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
            method: 'GET',
            url: this.url.replace('/mcp', '/health'),
            onload: (r) => resolve(JSON.parse(r.responseText)),
            onerror: (e) => reject(e),
            timeout: 5000,
          });
        });
        return resp.status === 'ok';
      } catch {
        return false;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Tool Registry — fetched from server, injected into requests
  // ═══════════════════════════════════════════════════════════════
  let toolRegistry = [];

  function buildToolHint() {
    if (!toolRegistry.length) return '';
    let hint = '[系统指令] 你拥有以下 MCP 工具。当用户的需求可以用工具完成时，你必须在回复中调用工具。';
    hint += ' 调用格式：用代码块写 ```mcp:工具名``` 后紧跟一个 JSON 代码块写参数。\n\n';
    hint += '示例：\n';
    hint += '```mcp:execute_command\n{"command": "ls -la"}\n```\n\n';
    hint += '可用工具列表：\n';
    toolRegistry.forEach(t => {
      hint += `- ${t.name}: ${t.description || ''}`;
      const req = t.inputSchema?.required;
      if (req?.length) hint += ` (参数: ${req.join(', ')})`;
      hint += '\n';
    });
    hint += '\n如果不需要工具就正常回答。需要工具时一定要调用。';
    return hint;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Call history (shared with UI)
  // ═══════════════════════════════════════════════════════════════
  const callHistory = [];

  // ═══════════════════════════════════════════════════════════════
  //  XHR Hook — request injection only
  //  Response is read via DOM observer instead.
  // ═══════════════════════════════════════════════════════════════
  const TOOL_CALL_RE = /```mcp:(\w+)\n([\s\S]*?)```/g;

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

      if (injected) {
        console.log(`${SCRIPT_PREFIX} ✅ Tool hint injected`);
        return JSON.stringify(parsed);
      }
    } catch (e) { /* not JSON */ }
    return bodyStr;
  }

  // Hook XHR for request injection
  const XHRProto = unsafeWindow.XMLHttpRequest.prototype;
  const origOpen = XHRProto.open;
  const origSend = XHRProto.send;

  XHRProto.open = function (method, url, ...rest) {
    this._dseUrl = url;
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XHRProto.send = function (body) {
    const url = this._dseUrl || '';
    if (url.includes('completion') && body && toolRegistry.length) {
      body = injectHint(body);
    }
    return origSend.apply(this, [body]);
  };

  // ═══════════════════════════════════════════════════════════════
  //  DOM Observer — detect tool calls from rendered chat messages
  //  DeepSeek streams via XHR SSE; responseText is inaccessible
  //  during the stream. So we watch the DOM for rendered code blocks
  //  containing mcp:tool_name patterns.
  // ═══════════════════════════════════════════════════════════════
  const executedCalls = new Set(); // dedup: "toolName:argsHash"

  function callKey(name, args) {
    return name + ':' + JSON.stringify(args);
  }

  function scanForToolCalls(root) {
    if (!root || !root.querySelectorAll) return;

    // Find code blocks with mcp: prefix (rendered from ```mcp:xxx```)
    const codeBlocks = root.querySelectorAll('code');
    for (const block of codeBlocks) {
      const text = block.textContent || '';
      const m = text.match(/^mcp:(\w+)\s*\n([\s\S]*)$/);
      if (!m) continue;

      const toolName = m[1];
      const rawArgs = m[2].trim();
      let args = {};
      try { args = JSON.parse(rawArgs); }
      catch { args = { input: rawArgs }; }

      const key = callKey(toolName, args);
      if (executedCalls.has(key)) continue; // already handled
      executedCalls.add(key);

      console.log(`${SCRIPT_PREFIX} 🔧 Detected tool call from DOM: ${toolName}`, args);
      executeToolCall(toolName, args);
    }
  }

  waitForDOM().then(() => {
    // Debounced scan: collect mutations and scan once after a pause
    let scanTimer = null;
    function scheduleScan() {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(() => scanForToolCalls(document.body), 500);
    }

    const observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, { childList: true, subtree: true });

    // Also scan periodically as safety net
    setInterval(() => scanForToolCalls(document.body), 5000);
  });

  // ═══════════════════════════════════════════════════════════════
  //  Tool Execution
  // ═══════════════════════════════════════════════════════════════
  let autoExecute = false;

  async function executeToolCall(toolName, args) {
    const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
    const client = new MCPClient(mcpUrl);

    const record = { time: Date.now(), tool: toolName, args, status: 'running', result: null };
    callHistory.unshift(record);
    if (callHistory.length > 50) callHistory.pop();
    window.dispatchEvent(new CustomEvent('dse-mcp-toolcall', { detail: record }));

    if (!autoExecute) {
      toast(`检测到工具调用: ${toolName}，请在面板中开启自动执行`, 'info');
      console.log(`${SCRIPT_PREFIX} Tool call detected (auto-exec off): ${toolName}`, args);
      return;
    }

    try {
      toast(`调用工具: ${toolName}...`, 'info');
      const result = await client.callTool(toolName, args);
      const resultText = result?.content?.[0]?.text || '(no result)';
      const isError = result?.isError;

      record.status = isError ? 'error' : 'success';
      record.result = resultText;

      toast(`${isError ? '失败' : '成功'}: ${toolName}`, isError ? 'error' : 'success');
      console.log(`${SCRIPT_PREFIX} Tool result (${toolName}):`, resultText.substring(0, 500));

    } catch (e) {
      record.status = 'error';
      record.result = e.message;
      toast(`工具调用失败: ${e.message}`, 'error');
      console.error(`${SCRIPT_PREFIX} Tool error:`, e);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Toast (needed before DOM ready, lightweight)
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
  //  Load UI after DOM is ready
  // ═══════════════════════════════════════════════════════════════
  function waitForDOM() {
    return new Promise((resolve) => {
      if (document.body) resolve();
      else {
        const obs = new MutationObserver(() => {
          if (document.body) { obs.disconnect(); resolve(); }
        });
        obs.observe(document.documentElement, { childList: true });
      }
    });
  }

  waitForDOM().then(initUI);

  // ═══════════════════════════════════════════════════════════════
  //  UI
  // ═══════════════════════════════════════════════════════════════
  function initUI() {
    autoExecute = GM_getValue('auto_execute', false);
    const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);

    // ── CSS ──
    const style = document.createElement('style');
    style.textContent = `
      #dse-fab{position:fixed;z-index:999999;width:48px;height:48px;border-radius:50%;background:#059669;color:#fff;border:none;font-size:22px;cursor:grab;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(5,150,105,.4);user-select:none;-webkit-user-select:none;touch-action:none}
      #dse-fab:active{cursor:grabbing}
      #dse-fab:hover{transform:scale(1.1);box-shadow:0 4px 20px rgba(5,150,105,.6)}
      #dse-fab.connected{background:#059669}
      #dse-fab.disconnected{background:#991b1b}

      #dse-panel{position:fixed;z-index:999998;width:460px;max-height:75vh;background:#16161e;color:#eee;border:1px solid #333;border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.6);font-family:system-ui;font-size:14px;display:none;flex-direction:column;overflow:hidden}
      #dse-panel.open{display:flex}
      #dse-panel .hd{padding:14px 18px;border-bottom:1px solid #2a2a3a;display:flex;align-items:center;justify-content:space-between}
      #dse-panel .hd h3{margin:0;font-size:15px;font-weight:600}
      #dse-panel .hd .cls{background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0 4px}
      #dse-panel .hd .cls:hover{color:#fff}

      #dse-tabs{display:flex;border-bottom:1px solid #2a2a3a;overflow-x:auto;scrollbar-width:none}
      #dse-tabs::-webkit-scrollbar{display:none}
      #dse-tabs button{flex:0 0 auto;padding:9px 14px;background:none;border:none;color:#888;font-size:12px;cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap}
      #dse-tabs button.active{color:#7aa2f7;border-bottom-color:#7aa2f7}
      #dse-tabs button:hover{color:#ccc}

      .dse-bd{flex:1;overflow-y:auto;padding:12px 14px}
      .dse-section{display:none}.dse-section.active{display:block}

      .dse-actions{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
      .dse-actions button{padding:6px 12px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;font-size:12px;cursor:pointer;transition:background .15s}
      .dse-actions button:hover{background:#333}
      .dse-actions button.pri{background:#059669;border-color:#059669;color:#fff}
      .dse-actions button.pri:hover{background:#10b981}
      .dse-actions button.dng{background:#7f1d1d;border-color:#991b1b}
      .dse-actions button.dng:hover{background:#991b1b}

      .dse-input{width:100%;padding:8px 12px;border-radius:8px;border:1px solid #444;background:#1a1a28;color:#eee;font-size:13px;box-sizing:border-box;outline:none}
      .dse-input:focus{border-color:#7aa2f7}
      .dse-input::placeholder{color:#555}

      .dse-tool-card{padding:10px 12px;background:#1a1a28;border-radius:10px;margin-bottom:8px;border:1px solid #2a2a3a}
      .dse-tool-card h4{margin:0 0 4px;font-size:13px;color:#7aa2f7}
      .dse-tool-card p{margin:0;font-size:12px;color:#888}

      .dse-log-item{padding:8px 10px;border-radius:8px;margin-bottom:6px;font-size:12px;border:1px solid #2a2a3a}
      .dse-log-item .log-head{display:flex;justify-content:space-between;margin-bottom:4px}
      .dse-log-item .log-tool{color:#7aa2f7;font-weight:600}
      .dse-log-item .log-time{color:#555}
      .dse-log-item .log-status{padding:1px 6px;border-radius:4px;font-size:11px}
      .dse-log-item .log-status.success{background:#0d3320;color:#6ee7b7}
      .dse-log-item .log-status.error{background:#3d0f0f;color:#fca5a5}
      .dse-log-item .log-status.running{background:#1a2a4a;color:#7aa2f7}
      .dse-log-item .log-args{color:#888;font-size:11px;white-space:pre-wrap;word-break:break-all}

      .dse-status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
      .dse-status-dot.green{background:#10b981}
      .dse-status-dot.red{background:#ef4444}
      .dse-status-dot.yellow{background:#f59e0b}

      .dse-test-result{margin-top:10px;padding:10px;background:#1a1a28;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;border:1px solid #2a2a3a}
    `;
    document.head.appendChild(style);

    // ── FAB ──
    const fab = document.createElement('button');
    fab.id = 'dse-fab';
    fab.innerHTML = '&#9881;';
    fab.title = 'DS MCP Bridge (可拖动)';
    fab.className = 'disconnected';
    document.body.appendChild(fab);

    // ── Panel ──
    const panel = document.createElement('div');
    panel.id = 'dse-panel';
    panel.innerHTML = `
      <div class="hd"><h3>DS MCP Bridge</h3><button class="cls">&times;</button></div>
      <div id="dse-tabs">
        <button class="active" data-tab="status">MCP 状态</button>
        <button data-tab="test">手动测试</button>
        <button data-tab="history">调用历史</button>
        <button data-tab="settings">设置</button>
      </div>
      <div class="dse-bd">
        <!-- Status -->
        <div id="sec-status" class="dse-section active">
          <div id="mcp-conn-status" style="margin-bottom:12px;font-size:13px">
            <span class="dse-status-dot yellow"></span>检测中...
          </div>
          <div class="dse-actions">
            <button id="mcp-connect" class="pri">连接服务器</button>
            <button id="mcp-refresh">刷新工具列表</button>
          </div>
          <div id="mcp-tools-list"></div>
        </div>

        <!-- Test -->
        <div id="sec-test" class="dse-section">
          <div style="color:#aaa;font-size:12px;margin-bottom:8px">手动测试工具调用（不依赖 AI）</div>
          <div style="margin-bottom:8px">
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">工具名称</label>
            <select id="test-tool" class="dse-input" style="padding:7px 10px;border-radius:8px;border:1px solid #444;background:#1a1a28;color:#eee;font-size:13px;outline:none">
              <option value="">加载中...</option>
            </select>
          </div>
          <div style="margin-bottom:8px">
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">参数 (JSON)</label>
            <textarea id="test-args" class="dse-input" rows="4" placeholder='{"command": "echo hello"}' style="resize:vertical;font-family:monospace"></textarea>
          </div>
          <div class="dse-actions">
            <button id="test-run" class="pri">执行</button>
          </div>
          <div id="test-result"></div>
        </div>

        <!-- History -->
        <div id="sec-history" class="dse-section">
          <div class="dse-actions">
            <button id="hist-clear">清空历史</button>
          </div>
          <div id="hist-list"></div>
        </div>

        <!-- Settings -->
        <div id="sec-settings" class="dse-section">
          <div style="margin-bottom:12px">
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">MCP 服务器地址</label>
            <input type="text" id="cfg-url" class="dse-input" value="${mcpUrl}">
          </div>
          <div style="margin-bottom:12px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
              <input type="checkbox" id="cfg-auto" ${autoExecute ? 'checked' : ''} style="width:16px;height:16px">
              自动执行工具调用（不需确认）
            </label>
            <div style="font-size:11px;color:#666;margin-top:4px;margin-left:24px">
              开启后，AI 回复中包含的工具调用将自动执行
            </div>
          </div>
          <div class="dse-actions">
            <button id="cfg-save" class="pri">保存设置</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // ── Drag ──
    let fabDragged = false, fabSX, fabSY, fabOX, fabOY;
    const DRAG_TH = 5;

    function posPanel() {
      const r = fab.getBoundingClientRect();
      let l = r.left;
      if (l + 460 > innerWidth - 10) l = innerWidth - 470;
      if (l < 10) l = 10;
      panel.style.left = l + 'px';
      panel.style.bottom = (innerHeight - r.top + 10) + 'px';
      panel.style.top = 'auto';
    }

    fab.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      fabDragged = false; fabSX = e.clientX; fabSY = e.clientY;
      const r = fab.getBoundingClientRect();
      fabOX = e.clientX - r.left; fabOY = e.clientY - r.top;
      const mv = (e) => {
        if (!fabDragged && Math.abs(e.clientX - fabSX) + Math.abs(e.clientY - fabSY) < DRAG_TH) return;
        fabDragged = true;
        fab.style.left = Math.max(0, Math.min(innerWidth - 48, e.clientX - fabOX)) + 'px';
        fab.style.top = Math.max(0, Math.min(innerHeight - 48, e.clientY - fabOY)) + 'px';
        fab.style.bottom = 'auto';
      };
      const up = () => {
        document.removeEventListener('pointermove', mv);
        document.removeEventListener('pointerup', up);
        if (!fabDragged) { panel.classList.toggle('open'); if (panel.classList.contains('open')) posPanel(); }
        else if (panel.classList.contains('open')) posPanel();
      };
      document.addEventListener('pointermove', mv);
      document.addEventListener('pointerup', up);
      e.preventDefault();
    });

    fab.style.left = '80px';
    fab.style.top = (innerHeight - 68) + 'px';
    panel.querySelector('.cls').onclick = () => panel.classList.remove('open');

    // ── Tab switching ──
    panel.querySelectorAll('#dse-tabs button').forEach(btn => {
      btn.onclick = () => {
        panel.querySelectorAll('#dse-tabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        panel.querySelectorAll('.dse-section').forEach(s => s.classList.remove('active'));
        panel.querySelector(`#sec-${tab}`).classList.add('active');
        if (tab === 'status') refreshStatus();
        if (tab === 'history') renderHistory();
      };
    });

    // ── Status ──
    const statusEl = panel.querySelector('#mcp-conn-status');
    const toolsListEl = panel.querySelector('#mcp-tools-list');

    async function refreshStatus() {
      const url = panel.querySelector('#cfg-url')?.value || GM_getValue('mcp_url', DEFAULT_MCP_URL);
      const client = new MCPClient(url);

      statusEl.innerHTML = '<span class="dse-status-dot yellow"></span>检测中...';
      toolsListEl.innerHTML = '';

      const healthy = await client.checkHealth();
      if (!healthy) {
        statusEl.innerHTML = '<span class="dse-status-dot red"></span>服务器未连接（请确保 server.py 正在运行）';
        fab.className = 'disconnected';
        toolRegistry = [];
        updateTestToolSelect();
        return;
      }

      try {
        await client.initialize();
        const tools = await client.listTools();
        toolRegistry = tools; // Store globally for fetch hook
        statusEl.innerHTML = `<span class="dse-status-dot green"></span>已连接 (${tools.length} 个工具)`;
        fab.className = 'connected';

        tools.forEach(t => {
          const card = document.createElement('div');
          card.className = 'dse-tool-card';
          card.innerHTML = `<h4>${t.name}</h4><p>${t.description || ''}</p>`;
          toolsListEl.appendChild(card);
        });

        updateTestToolSelect();
      } catch (e) {
        statusEl.innerHTML = `<span class="dse-status-dot red"></span>连接失败: ${e.message}`;
        fab.className = 'disconnected';
        toolRegistry = [];
        updateTestToolSelect();
      }
    }

    panel.querySelector('#mcp-connect').onclick = refreshStatus;
    panel.querySelector('#mcp-refresh').onclick = refreshStatus;

    // ── Manual Test ──
    const testToolSelect = panel.querySelector('#test-tool');
    const testArgsInput = panel.querySelector('#test-args');
    const testResultEl = panel.querySelector('#test-result');

    function updateTestToolSelect() {
      testToolSelect.innerHTML = '';
      if (!toolRegistry.length) {
        testToolSelect.innerHTML = '<option value="">请先连接服务器</option>';
        return;
      }
      toolRegistry.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.name;
        opt.textContent = `${t.name} — ${t.description || ''}`;
        testToolSelect.appendChild(opt);
      });
      // Auto-fill example args for first tool
      autoFillTestArgs();
    }

    function autoFillTestArgs() {
      const toolName = testToolSelect.value;
      const tool = toolRegistry.find(t => t.name === toolName);
      if (!tool) return;
      const example = {};
      const props = tool.inputSchema?.properties || {};
      for (const [key, val] of Object.entries(props)) {
        if (val.type === 'string') example[key] = '';
        else if (val.type === 'integer') example[key] = 0;
      }
      testArgsInput.value = JSON.stringify(example, null, 2);
      testArgsInput.placeholder = `参数: ${Object.keys(props).join(', ') || '无参数'}`;
    }

    testToolSelect.onchange = autoFillTestArgs;

    panel.querySelector('#test-run').onclick = async () => {
      const toolName = testToolSelect.value;
      if (!toolName) { toast('请先连接服务器', 'error'); return; }

      let args = {};
      const raw = testArgsInput.value.trim();
      if (raw) {
        try { args = JSON.parse(raw); }
        catch (e) { toast(`JSON 格式错误: ${e.message}`, 'error'); return; }
      }

      testResultEl.innerHTML = '<div style="color:#888">执行中...</div>';
      const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
      const client = new MCPClient(mcpUrl);

      const record = { time: Date.now(), tool: toolName, args, status: 'running', result: null };
      callHistory.unshift(record);

      try {
        const result = await client.callTool(toolName, args);
        const resultText = result?.content?.[0]?.text || '(no result)';
        const isError = result?.isError;

        record.status = isError ? 'error' : 'success';
        record.result = resultText;

        testResultEl.innerHTML = `<div style="color:${isError ? '#fca5a5' : '#6ee7b7'}">${esc(resultText)}</div>`;
        toast(isError ? '工具返回错误' : '执行成功', isError ? 'error' : 'success');
      } catch (e) {
        record.status = 'error';
        record.result = e.message;
        testResultEl.innerHTML = `<div style="color:#fca5a5">Error: ${esc(e.message)}</div>`;
        toast(`执行失败: ${e.message}`, 'error');
      }
    };

    // ── History ──
    const histListEl = panel.querySelector('#hist-list');

    function renderHistory() {
      histListEl.innerHTML = '';
      if (!callHistory.length) {
        histListEl.innerHTML = '<div style="color:#555;font-size:13px;padding:12px 0">暂无调用记录</div>';
        return;
      }
      callHistory.forEach(r => {
        const item = document.createElement('div');
        item.className = 'dse-log-item';
        const time = new Date(r.time);
        const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`;
        item.innerHTML = `
          <div class="log-head">
            <span class="log-tool">${r.tool}</span>
            <span>
              <span class="log-status ${r.status}">${r.status}</span>
              <span class="log-time">${timeStr}</span>
            </span>
          </div>
          <div class="log-args">${esc(JSON.stringify(r.args))}</div>
          ${r.result ? `<div class="log-args" style="margin-top:4px;color:#6ee7b7">${esc(r.result.substring(0, 200))}</div>` : ''}
        `;
        histListEl.appendChild(item);
      });
    }

    panel.querySelector('#hist-clear').onclick = () => { callHistory.length = 0; renderHistory(); };

    window.addEventListener('dse-mcp-toolcall', () => {
      if (panel.querySelector('#sec-history.active')) renderHistory();
    });

    // ── Settings ──
    panel.querySelector('#cfg-save').onclick = () => {
      const url = panel.querySelector('#cfg-url').value.trim();
      const auto = panel.querySelector('#cfg-auto').checked;
      GM_setValue('mcp_url', url);
      GM_setValue('auto_execute', auto);
      autoExecute = auto;
      toast('设置已保存', 'success');
      refreshStatus();
    };

    // ── Keyboard shortcut ──
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        panel.classList.toggle('open');
        if (panel.classList.contains('open')) posPanel();
      }
    });

    // ── Init ──
    setTimeout(refreshStatus, 1000);

    function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

    console.log(`${SCRIPT_PREFIX} DS MCP Bridge v1.1.0 loaded — Ctrl+Shift+M or 绿色按钮`);
  }
})();
