/*! Traffic Counter tracker · MIT · no cookies, no storage of personal data */
(function (w, d) {
  'use strict';
  var script = d.currentScript || d.querySelector('script[data-site]');
  if (!script || w.tc && w.tc.loaded) return;
  var site = script.getAttribute('data-site');
  var attr = function (n) { var v = script.getAttribute('data-' + n); return v !== null && v !== 'false'; };
  var endpoint = script.getAttribute('data-endpoint') || new URL(script.src).origin + '/api/hit';
  var lastPath = null;
  var firstView = true;

  // Owner opt-out: visit any page with #tc-ignore to toggle counting for this browser.
  try {
    if (location.hash === '#tc-ignore') {
      if (localStorage.getItem('tc_ignore')) { localStorage.removeItem('tc_ignore'); alert('Traffic Counter: your visits will be counted again.'); }
      else { localStorage.setItem('tc_ignore', '1'); alert('Traffic Counter: your visits on this browser are now ignored.'); }
    }
  } catch (e) {}

  function skip() {
    try { if (localStorage.getItem('tc_ignore')) return 'ignored'; } catch (e) {}
    if (!attr('allow-local') && /^(localhost|127\.|0\.0\.0\.0|\[::1\]|.*\.local$|.*\.test$)/.test(location.hostname)) return 'localhost';
    if (!attr('allow-local') && location.protocol === 'file:') return 'file';
    if (!attr('allow-frame') && w !== w.top) return 'frame';
    if (attr('respect-dnt') && (navigator.doNotTrack === '1' || navigator.globalPrivacyControl)) return 'dnt';
    return '';
  }

  function isBot() {
    return navigator.webdriver || w.callPhantom || w._phantom || w.__nightmare || d.__selenium_unwrapped ? 1 : 0;
  }

  function send(data) {
    var why = skip();
    if (why) { if (w.console && attr('debug')) console.info('Traffic Counter: not counting (' + why + ')'); return; }
    data.s = site;
    var body = JSON.stringify(data);
    // sendBeacon posts as text/plain, which avoids a CORS preflight.
    if (navigator.sendBeacon && navigator.sendBeacon(endpoint, body)) return;
    if (w.fetch) { fetch(endpoint, { method: 'POST', body: body, keepalive: true, mode: 'no-cors' }); return; }
    var q = []; for (var k in data) q.push(encodeURIComponent(k) + '=' + encodeURIComponent(data[k]));
    new Image().src = endpoint + '.gif?' + q.join('&');
  }

  function pageview(opts) {
    opts = opts || {};
    var path = opts.path || (attr('hash') ? location.pathname + location.hash : location.pathname);
    if (!opts.force && path === lastPath) return;
    lastPath = path;
    send({
      p: path,
      t: opts.title || d.title,
      r: opts.referrer !== undefined ? opts.referrer : (firstView ? d.referrer : ''),
      q: location.search,
      w: w.screen && w.screen.width || 0,
      l: navigator.language || '',
      tp: navigator.maxTouchPoints || 0,
      b: isBot()
    });
    firstView = false;
  }

  function event(name, opts) {
    opts = opts || {};
    send({ p: String(name).slice(0, 200), t: opts.title || '', e: 1, r: '', q: '', w: w.screen && w.screen.width || 0, l: navigator.language || '', tp: navigator.maxTouchPoints || 0, b: isBot() });
  }

  // Public API: tc.pageview({path}), tc.event('signup')
  w.tc = { loaded: true, pageview: pageview, event: event };

  // Declarative events: <button data-tc-event="signup">
  d.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('[data-tc-event],a[href]');
    if (!el) return;
    var name = el.getAttribute('data-tc-event');
    if (name) return event(name, { title: el.getAttribute('data-tc-title') || (el.textContent || '').trim().slice(0, 100) });
    if (attr('outbound') && el.host && el.host !== location.host && /^https?:/.test(el.protocol)) event('outbound: ' + el.host, { title: el.href });
  }, true);

  // Single-page apps: count client-side navigations automatically.
  if (!attr('no-spa')) {
    var wrap = function (fn) { return function () { var r = fn.apply(this, arguments); setTimeout(pageview, 0); return r; }; };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    w.addEventListener('popstate', function () { pageview(); });
    if (attr('hash')) w.addEventListener('hashchange', function () { pageview(); });
  }

  if (attr('manual')) return;
  // Don't count pages that are only being prerendered until they're shown.
  if (d.visibilityState === 'prerender' || d.prerendering) {
    d.addEventListener(d.prerendering ? 'prerenderingchange' : 'visibilitychange', function f() { d.removeEventListener('visibilitychange', f); pageview(); }, { once: true });
  } else pageview();
})(window, document);
