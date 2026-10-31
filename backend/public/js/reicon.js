/* reicon.js — swaps Font Awesome glyphs for Reicon icons across agent1102.
 *
 * Why it works this way: the <i class="fa-solid fa-…"> elements are LEFT IN PLACE
 * (other scripts may hold references to them or change their class), and a Reicon
 * glyph is injected inside each one. A MutationObserver covers buttons created
 * later by chat.js / copy.js / commands.js / etc. (copy, copy-success, download,
 * sound, redo, command icons…).
 *
 * Safety net: if an icon name below doesn't exist in Reicon (or fails to render),
 * that one icon silently falls back to Font Awesome and a console warning names it.
 * Fix a miss by editing MAP — browse names at https://reicon.dev/icons
 *
 * Icon artwork: Reicon (MIT), built on Solar Icons by 480 Design (CC BY 4.0).
 */
(function () {
  'use strict';

  // Font Awesome name (without "fa-")  ->  Reicon name (kebab-case)
  var MAP = {
    // ── the buttons you listed ──
    'copy': 'copy', 'clone': 'copy',
    'check': 'check-circle', 'circle-check': 'check-circle',          // copy success
    'download': 'download-minimalistic', 'file-arrow-down': 'download-minimalistic',
    'volume-high': 'volume-loud', 'volume-up': 'volume-loud',          // sound
    'volume-low': 'volume-small', 'volume-off': 'volume-small',        // volume
    'volume-xmark': 'volume-cross', 'volume-mute': 'volume-cross',
    'plus': 'add-circle', 'circle-plus': 'add-circle',                 // add
    'comment': 'chat-round', 'message': 'chat-round',                  // message
    'comments': 'chat-round-dots',
    'pencil': 'pen-new-square', 'pen-to-square': 'pen-new-square',     // new chat
    'moon': 'moon', 'sun': 'sun',                                      // light/dark
    'image': 'gallery', 'images': 'gallery', 'camera': 'camera',
    'circle-user': 'user-circle', 'user': 'user',
    'xmark': 'close-circle', 'times': 'close-circle', 'circle-xmark': 'close-circle',
    'trash-can': 'trash-bin-trash', 'trash': 'trash-bin-trash',
    'arrow-right-from-bracket': 'logout', 'right-from-bracket': 'logout', 'sign-out-alt': 'logout',
    'eye': 'eye', 'eye-slash': 'eye-closed',                           // see/hide password
    'ban': 'forbidden-circle',                                         // cancel
    'floppy-disk': 'diskette', 'save': 'diskette',                     // save
    'rotate-right': 'restart', 'arrow-rotate-right': 'restart',        // redo
    'rotate-left': 'restart', 'arrows-rotate': 'refresh', 'rotate': 'refresh', 'redo': 'restart',

    // ── input bar ──
    'paperclip': 'paperclip', 'microphone': 'microphone', 'microphone-slash': 'microphone-slash',
    'paper-plane': 'plain', 'stop': 'stop-circle', 'circle-stop': 'stop-circle',
    'play': 'play-circle', 'pause': 'pause-circle', 'upload': 'upload-minimalistic',

    // ── likely slash-command / tool icons ──
    'bars': 'hamburger-menu', 'gear': 'settings', 'cog': 'settings', 'sliders': 'tuning-2',
    'magnifying-glass': 'magnifer', 'search': 'magnifer',
    'pen': 'pen', 'share': 'share', 'link': 'link', 'file': 'file', 'file-lines': 'file-text',
    'file-pdf': 'file-text', 'file-zipper': 'zip-file', 'folder': 'folder', 'box-archive': 'archive',
    'chevron-down': 'alt-arrow-down', 'chevron-up': 'alt-arrow-up',
    'chevron-left': 'alt-arrow-left', 'chevron-right': 'alt-arrow-right',
    'arrow-up': 'arrow-up', 'arrow-down': 'arrow-down', 'arrow-left': 'arrow-left', 'arrow-right': 'arrow-right',
    'lightbulb': 'lightbulb', 'code': 'code', 'terminal': 'code-square', 'calculator': 'calculator',
    'chart-line': 'chart-2', 'chart-simple': 'chart', 'chart-pie': 'pie-chart', 'chart-bar': 'chart',
    'book': 'book', 'book-open': 'book-2', 'graduation-cap': 'square-academic-cap',
    'wand-magic-sparkles': 'magic-stick-3', 'bolt': 'bolt', 'star': 'star', 'bookmark': 'bookmark',
    'clock': 'clock-circle', 'calendar': 'calendar', 'globe': 'global', 'language': 'translation',
    'cloud-sun': 'cloud-sun', 'brain': 'cpu', 'robot': 'cpu-bolt', 'microchip': 'cpu',
    'question': 'question-circle', 'circle-question': 'question-circle',
    'info': 'info-circle', 'circle-info': 'info-circle',
    'triangle-exclamation': 'danger-triangle', 'exclamation': 'danger-circle',
    'thumbs-up': 'like', 'thumbs-down': 'dislike', 'heart': 'heart',
    'lock': 'lock', 'key': 'key', 'envelope': 'letter', 'phone': 'phone',
    'expand': 'maximize', 'compress': 'minimize', 'list': 'list', 'table': 'server-square',
    'quote-left': 'chat-line', 'gamepad': 'gamepad', 'music': 'music-note', 'dice': 'dice',
    'palette': 'pallete-2', 'spinner': 'refresh', 'circle-notch': 'refresh',
    'ellipsis': 'menu-dots', 'ellipsis-vertical': 'menu-dots', 'house': 'home', 'flask': 'test-tube',
    'newspaper': 'document-text', 'map': 'map', 'location-dot': 'map-point', 'cart-shopping': 'cart'
  };
  // Font Awesome brand icons (discord, github…) and anything not in MAP are left alone.

  var SEL = 'i[class*="fa-"]';
  var warned = {};

  var css = document.createElement('style');
  css.textContent =
    'i[data-ri]{display:inline-flex;align-items:center;justify-content:center;font-style:normal;vertical-align:-0.15em;}' +
    'i[data-ri]::before,i[data-ri]::after{content:none!important;}' +
    'i[data-ri]>.ri-glyph{display:inline-flex;line-height:0;}';
  document.head.appendChild(css);

  function lookup(el) {
    if (el.classList.contains('fa-brands')) return null;
    for (var i = 0; i < el.classList.length; i++) {
      var c = el.classList[i];
      if (c.indexOf('fa-') === 0 && MAP[c.slice(3)]) return MAP[c.slice(3)];
    }
    return null;
  }

  function build(name, size) {
    var g;
    if (window.customElements && customElements.get('re-icon')) {        // <re-icon> web component
      g = document.createElement('re-icon');
      g.setAttribute('icon', name);
      g.setAttribute('weight', 'outline');
      g.setAttribute('size', size);
      g.setAttribute('color', 'currentColor');
    } else if (window.reicon) {                                           // global function build
      var P = name.split('-').map(function (s) { return s.charAt(0).toUpperCase() + s.slice(1); }).join('');
      if (typeof window.reicon[P] !== 'function') return null;
      g = window.reicon[P]({ size: size, color: 'currentColor' });
    } else {
      return null;
    }
    g.classList.add('ri-glyph');
    return g;
  }

  function rendered(g) {
    return !!(g.tagName.toLowerCase() === 'svg' || g.querySelector('svg') ||
      (g.shadowRoot && g.shadowRoot.querySelector('svg')) || g.offsetWidth > 0);
  }

  function apply(el) {
    var old = el.querySelector(':scope > .ri-glyph');
    var name = lookup(el);
    if (!name || el.getAttribute('data-ri-failed') === name) {
      if (old) old.remove();
      el.removeAttribute('data-ri');
      return;
    }
    if (old && old.getAttribute('data-name') === name) return;           // already up to date
    if (old) old.remove();
    var size = Math.round(parseFloat(getComputedStyle(el).fontSize)) || 18;
    var g = build(name, size);
    if (!g) { el.removeAttribute('data-ri'); return; }
    g.setAttribute('data-name', name);
    el.appendChild(g);
    el.setAttribute('data-ri', '');
    setTimeout(function () {                                              // verify it actually drew
      if (!g.isConnected || rendered(g)) return;
      g.remove();
      el.removeAttribute('data-ri');
      el.setAttribute('data-ri-failed', name);
      if (!warned[name]) { warned[name] = 1; console.warn('[reicon] no icon named "' + name + '" — kept Font Awesome. Edit MAP in js/reicon.js.'); }
    }, 400);
  }

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(SEL)) apply(root);
    root.querySelectorAll(SEL).forEach(apply);
  }

  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'attributes') {
        if (m.target.tagName === 'I') { m.target.removeAttribute('data-ri-failed'); apply(m.target); }
      } else {
        m.addedNodes.forEach(scan);
      }
    }
  }).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['class']
  });

  function init() { scan(document.body); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
