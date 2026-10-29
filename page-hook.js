// Runs in the page's MAIN world at document_start (see manifest.json).
// Records the ClientSource header the VFS app sends to lift-api so content.js
// can reuse it. Read-only: never changes the page's requests.
(() => {
  'use strict';

  if (window.__VFS_PAGE_HOOK__) return;
  window.__VFS_PAGE_HOOK__ = true;

  const API_HOST = 'lift-api.vfsglobal.com';
  const HEADER_NAME = 'clientsource';

  function record(url, value) {
    try {
      if (!value || !String(url || '').includes(API_HOST)) return;
      sessionStorage.setItem('VFS_CLIENT_SOURCE', String(value));
      sessionStorage.setItem('VFS_CLIENT_SOURCE_TS', String(Date.now()));
    } catch (e) {}
  }

  // Headers instance, plain object, or [[name, value]] array.
  function readHeader(headers) {
    if (!headers) return null;
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      return headers.get(HEADER_NAME);
    }
    if (Array.isArray(headers)) {
      const pair = headers.find((h) => h && String(h[0]).toLowerCase() === HEADER_NAME);
      return pair ? pair[1] : null;
    }
    const key = Object.keys(headers).find((k) => k.toLowerCase() === HEADER_NAME);
    return key ? headers[key] : null;
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        const isRequest = typeof Request !== 'undefined' && input instanceof Request;
        const url = isRequest ? input.url : input;
        const value = readHeader(init && init.headers) || (isRequest ? readHeader(input.headers) : null);
        record(url, value);
      } catch (e) {}
      return originalFetch.apply(this, arguments);
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__vfsUrl = String(url);
    } catch (e) {}
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (String(name).toLowerCase() === HEADER_NAME) record(this.__vfsUrl, value);
    } catch (e) {}
    return originalSetRequestHeader.apply(this, arguments);
  };
})();
