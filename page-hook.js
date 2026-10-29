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

  // --- Page's own CheckIsSlotAvailable responses (UAE dropdown flow) -------
  // content.js drives the dropdowns; the page makes the call with a valid
  // ClientSource, and we copy the result here. Only dates/status are stored.

  const SLOT_PATH = '/appointment/CheckIsSlotAvailable';
  let warnedResponseType = false;

  function isSlotUrl(url) {
    return String(url || '').includes(API_HOST) && String(url || '').includes(SLOT_PATH);
  }

  function recordSlotResponse(requestBody, status, data) {
    try {
      let req = {};
      try {
        req = typeof requestBody === 'string' ? JSON.parse(requestBody) : {};
      } catch (e) {}
      sessionStorage.setItem('VFS_LAST_SLOT_RESPONSE', JSON.stringify({
        ts: Date.now(),
        status: Number(status) || 0,
        vacCode: (req && req.vacCode) || null,
        visaCategoryCode: (req && req.visaCategoryCode) || null,
        earliestDate: (data && data.earliestDate) || null
      }));
    } catch (e) {}
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      let slotBody = null;
      try {
        const isRequest = typeof Request !== 'undefined' && input instanceof Request;
        const url = isRequest ? input.url : input;
        const value = readHeader(init && init.headers) || (isRequest ? readHeader(input.headers) : null);
        record(url, value);
        if (isSlotUrl(url)) {
          // A Request's body is consumed by fetch, so read it from a clone taken first.
          slotBody = init && typeof init.body === 'string'
            ? Promise.resolve(init.body)
            : (isRequest ? input.clone().text() : Promise.resolve(null));
          // Handled here so a rejected clone never surfaces as an unhandled rejection in the page.
          slotBody.catch(() => {});
        }
      } catch (e) {}

      const result = originalFetch.apply(this, arguments);

      if (slotBody) {
        // Side branch only: the page still gets `result` untouched.
        Promise.resolve(result)
          .then((res) => Promise.all([
            slotBody.catch(() => null),
            res.clone().json().catch(() => null)
          ]).then(([body, data]) => recordSlotResponse(body, res.status, data)))
          .catch(() => {});
      }

      return result;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (isSlotUrl(this.__vfsUrl)) {
        const xhr = this;
        xhr.addEventListener('loadend', () => {
          try {
            // loadend also fires on abort/error/timeout (status 0): not a response.
            if (!xhr.status) return;
            let data = null;
            const type = xhr.responseType;
            // responseText throws for non-text responseTypes, so read by type.
            if (type === 'json') {
              data = xhr.response;
            } else if (type === '' || type === 'text') {
              try {
                data = JSON.parse(xhr.responseText);
              } catch (e) {}
            } else if (!warnedResponseType) {
              warnedResponseType = true;
              console.warn('[VFS Extension] page-hook: unsupported responseType', type);
            }
            recordSlotResponse(typeof body === 'string' ? body : null, xhr.status, data);
          } catch (e) {}
        }, { once: true });
      }
    } catch (e) {}
    return originalSend.apply(this, arguments);
  };

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
