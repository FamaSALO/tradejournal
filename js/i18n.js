(function () {
  'use strict';
  const NS = (window.TJ = window.TJ || {});
  const DICT = window.TJ_I18N_EN && typeof window.TJ_I18N_EN === 'object' ? window.TJ_I18N_EN : {};

  const CYRILLIC = /[А-Яа-яЁё]/;
  const SKIP_SELECTOR = '[data-i18n-skip], script, style, textarea, pre, code, [contenteditable="true"]';
  const ATTR_SKIP_SELECTOR = '[data-i18n-skip], script, style, pre, code, [contenteditable="true"]';
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tooltip'];

  function storedLanguage() {
    try {
      if (NS.prefs && typeof NS.prefs.get === 'function') return NS.prefs.get().lang;
      const raw = localStorage.getItem('tradejournal.preferences.v1');
      if (raw) {
        const prefs = JSON.parse(raw);
        if (prefs && prefs.lang === 'en') return 'en';
      }
    } catch (err) { /* ignore */ }
    return 'ru';
  }

  let language = storedLanguage();

  function lang() {
    return language;
  }

  function locale() {
    return language === 'en' ? 'en-US' : 'ru-RU';
  }

  function isCyrillic(ch) {
    return !!ch && CYRILLIC.test(ch);
  }

  // A trie keeps substring matching fast enough for large rendered tables.
  const trie = { children: Object.create(null), word: '' };
  Object.keys(DICT).forEach(function (source) {
    const key = String(source || '').trim();
    if (!key || key.length > 400 || !CYRILLIC.test(key)) return;
    if (/^[^\p{L}\p{N}]+$/u.test(key)) return;
    let node = trie;
    for (let i = 0; i < key.length; i++) {
      const ch = key.charAt(i);
      if (!node.children[ch]) node.children[ch] = { children: Object.create(null), word: '' };
      node = node.children[ch];
    }
    node.word = key;
  });

  function translatePhrases(text) {
    let result = '';
    let index = 0;
    while (index < text.length) {
      let node = trie;
      let cursor = index;
      let best = '';
      let bestEnd = index;
      while (cursor < text.length) {
        const child = node.children[text.charAt(cursor)];
        if (!child) break;
        node = child;
        cursor++;
        if (node.word) {
          const key = node.word;
          const before = index > 0 ? text.charAt(index - 1) : '';
          const after = cursor < text.length ? text.charAt(cursor) : '';
          const startLetter = CYRILLIC.test(key.charAt(0));
          const endLetter = CYRILLIC.test(key.charAt(key.length - 1));
          if ((startLetter && isCyrillic(before)) || (endLetter && isCyrillic(after))) continue;
          best = key;
          bestEnd = cursor;
        }
      }
      if (best) {
        result += DICT[best];
        index = bestEnd;
      } else {
        result += text.charAt(index);
        index++;
      }
    }
    return result;
  }

  function translate(input) {
    const text = String(input === null || input === undefined ? '' : input);
    if (language !== 'en' || !CYRILLIC.test(text)) return text;
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    const lead = match ? match[1] : '';
    const core = match ? match[2] : text;
    const tail = match ? match[3] : '';
    if (!core) return text;
    const exact = DICT[core];
    if (exact) return lead + exact + tail;
    const phrase = translatePhrases(core);
    return phrase === core ? text : lead + phrase + tail;
  }

  function skipNode(node) {
    let element = node.nodeType === 1 ? node : node.parentElement;
    if (!element || typeof element.closest !== 'function') return true;
    return !!element.closest(SKIP_SELECTOR);
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== 3) return;
    const value = node.nodeValue;
    if (!value || !CYRILLIC.test(value)) return;
    if (skipNode(node)) return;
    const next = translate(value);
    if (next !== value) node.nodeValue = next;
  }

  function translateAttributes(element) {
    if (!element || element.nodeType !== 1) return;
    if (typeof element.closest === 'function' && element.closest(ATTR_SKIP_SELECTOR)) return;
    ATTRS.forEach(function (name) {
      if (!element.hasAttribute(name)) return;
      const value = element.getAttribute(name);
      if (!value || !CYRILLIC.test(value)) return;
      const next = translate(value);
      if (next !== value) element.setAttribute(name, next);
    });
  }

  function translateDom(root) {
    if (language !== 'en' || !root) return;
    if (root.nodeType === 3) {
      translateTextNode(root);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (typeof root.closest === 'function' && root.closest(SKIP_SELECTOR)) return;
      translateAttributes(root);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === 3) translateTextNode(node);
      else translateAttributes(node);
      node = walker.nextNode();
    }
  }

  function setLanguage(next, options) {
    options = options || {};
    const value = next === 'en' ? 'en' : 'ru';
    language = value;
    try {
      if (NS.prefs && typeof NS.prefs.save === 'function') NS.prefs.save({ lang: value });
    } catch (err) { /* ignore */ }
    if (options.reload) {
      window.location.reload();
      return value;
    }
    document.documentElement.lang = value;
    translateDom(document.documentElement);
    return value;
  }

  function installObserver() {
    if (typeof MutationObserver !== 'function' || !document.documentElement) return;
    const observer = new MutationObserver(function (mutations) {
      if (language !== 'en') return;
      mutations.forEach(function (mutation) {
        if (mutation.type === 'characterData') {
          translateTextNode(mutation.target);
          return;
        }
        if (mutation.type === 'attributes') {
          translateAttributes(mutation.target);
          return;
        }
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType === 3) translateTextNode(node);
          else if (node.nodeType === 1) translateDom(node);
        });
      });
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS
    });
  }

  function start() {
    document.documentElement.lang = language;
    translateDom(document.documentElement);
    installObserver();
  }

  NS.i18n = {
    lang: lang,
    locale: locale,
    t: translate,
    translate: translate,
    translateDom: translateDom,
    setLanguage: setLanguage,
    hasDictionary: Object.keys(DICT).length > 0
  };
  NS.t = translate;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
