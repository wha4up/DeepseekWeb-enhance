// ==UserScript==
// @name         Hook Test
// @match        https://chat.deepseek.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[HookTest]';

  // 1. Log immediately
  console.log(TAG, 'script loaded, unsafeWindow type:', typeof unsafeWindow);
  console.log(TAG, 'unsafeWindow.fetch type:', typeof unsafeWindow?.fetch);

  // 2. Hook fetch
  const origFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (url) console.log(TAG, 'fetch intercepted →', url.substring(0, 120));
    return origFetch.apply(this, args);
  };
  console.log(TAG, 'fetch hook installed');

  // 3. Also hook XMLHttpRequest as fallback check
  const origXHROpen = unsafeWindow.XMLHttpRequest.prototype.open;
  unsafeWindow.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (url && typeof url === 'string') {
      console.log(TAG, 'XHR intercepted →', method, url.substring(0, 120));
    }
    return origXHROpen.apply(this, [method, url, ...rest]);
  };
  console.log(TAG, 'XHR hook installed');

  // 4. Log after 3 seconds to confirm hooks are still alive
  setTimeout(() => {
    console.log(TAG, 'hooks alive after 3s, fetch is hooked:', unsafeWindow.fetch !== origFetch);
  }, 3000);
})();
