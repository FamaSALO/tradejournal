(function () {
  'use strict';
  const NS = (window.TJ = window.TJ || {});
  const desktop = window.tradeJournalDesktop || null;
  let registration = null;
  let waitingWorker = null;
  let updateHandler = null;
  let reloading = false;

  function supported() {
    if (desktop) return false;
    if (!('serviceWorker' in navigator)) return false;
    return location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  function notify(worker) {
    waitingWorker = worker;
    if (typeof updateHandler === 'function') updateHandler();
  }

  function register() {
    navigator.serviceWorker.register('sw.js').then(function (value) {
      registration = value;
      if (registration.waiting) notify(registration.waiting);
      registration.addEventListener('updatefound', function () {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', function () {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) notify(worker);
        });
      });
      setInterval(function () {
        registration.update().catch(function () { /* offline is fine */ });
      }, 60 * 60 * 1000);
    }).catch(function (err) {
      console.warn('TradeJournal: service worker не зарегистрирован', err);
    });
  }

  function init(options) {
    updateHandler = options && options.onUpdate;
    if (!supported()) return;
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register);
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }

  function applyUpdate() {
    if (waitingWorker) {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      return;
    }
    location.reload();
  }

  function check() {
    if (!registration) return Promise.resolve(false);
    return registration.update().then(function () { return true; }).catch(function () { return false; });
  }

  NS.pwa = {
    supported: supported,
    init: init,
    applyUpdate: applyUpdate,
    check: check
  };
})();
