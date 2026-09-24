/*!
 * 公共层：设置存储 / 键位 / 音效 / 通用 UI
 * 依赖：无（WebAudio 合成音效，不需要任何音频文件）
 */
window.WB = window.WB || {};
(function (WB) {
  'use strict';

  /* ================= 工具 ================= */
  var util = WB.util = {
    clamp(v, a, b) { return v < a ? a : (v > b ? b : v); },
    esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },
    el(tag, cls, html) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (html != null) e.innerHTML = html;
      return e;
    },
    $(sel, root) { return (root || document).querySelector(sel); },
    $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  };

  /* ================= 键位 ================= */
  var KEYNAMES = {
    Space: '空格', Enter: '回车', Escape: 'Esc', Tab: 'Tab', Backspace: '退格',
    ShiftLeft: '左Shift', ShiftRight: '右Shift', ControlLeft: '左Ctrl', ControlRight: '右Ctrl',
    AltLeft: '左Alt', AltRight: '右Alt', CapsLock: '大写锁定',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
    NumpadAdd: '小键盘+', NumpadSubtract: '小键盘-', NumpadEnter: '小键盘回车', NumpadDecimal: '小键盘.'
  };
  var keys = WB.keys = {
    name(code) {
      if (!code) return '—';
      if (KEYNAMES[code]) return KEYNAMES[code];
      var m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
      m = /^Digit(\d)$/.exec(code); if (m) return m[1];
      m = /^Numpad(\d)$/.exec(code); if (m) return '小键盘' + m[1];
      m = /^F(\d+)$/.exec(code); if (m) return code;
      return code;
    },
    /** 是否为合法的可绑定键 */
    valid(code) {
      if (!code) return false;
      if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code)) return true;
      if (/^F\d+$/.test(code)) return true;
      if (/^(Key[A-Z]|Digit\d|Numpad\d|Arrow\w+|Space|Enter|Tab|Backquote|Minus|Equal|Bracket\w+|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(code)) return true;
      return false;
    },
    /** 监听一次按键，回调 code；返回取消函数 */
    capture(cb) {
      var handler = function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.code === 'Escape') { cleanup(); cb(null); return; }
        if (!WB.keys.valid(e.code)) return;
        cleanup(); cb(e.code);
      };
      var cleanup = function () {
        window.removeEventListener('keydown', handler, true);
      };
      window.addEventListener('keydown', handler, true);
      return cleanup;
    }
  };

  /* ================= 设置 ================= */
  var STORE_KEY = 'wb.games.settings.v1';
  var ACTIONS = [
    { k: 'up', label: '前进' }, { k: 'down', label: '后退' },
    { k: 'left', label: '左转' }, { k: 'right', label: '右转' },
    { k: 'fire', label: '开火' }
  ];
  var DEFAULTS = {
    sfxVolume: 0.7,
    muted: false,
    name: '',
    rounds: 20,
    keys: {
      p1: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', fire: 'Space' },
      p2: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', fire: 'KeyF' }
    }
  };

  function deepMerge(target, src) {
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      var v = src[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        target[k] = target[k] && typeof target[k] === 'object' ? target[k] : {};
        deepMerge(target[k], v);
      } else if (v !== undefined && v !== null) {
        target[k] = v;
      }
    }
    return target;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var settings = clone(DEFAULTS);
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (raw) deepMerge(settings, JSON.parse(raw));
  } catch (e) { /* 忽略损坏的本地数据 */ }

  var settingsApi = WB.settings = {
    ACTIONS: ACTIONS,
    DEFAULTS: DEFAULTS,
    get() { return settings; },
    save() {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* noop */ }
      WB.audio.setVolume(settings.sfxVolume, settings.muted);
      window.dispatchEvent(new CustomEvent('wb:settings', { detail: settings }));
    },
    reset() {
      settings = deepMerge(clone(DEFAULTS), { name: settings.name });
      settingsApi.save();
      return settings;
    },
    /** 该键位是否与同一玩家的其它动作冲突 */
    conflict(player, action, code) {
      var set = settings.keys[player];
      for (var k in set) if (k !== action && set[k] === code) return k;
      return null;
    }
  };
  WB.audio_initVolume = function () { WB.audio.setVolume(settings.sfxVolume, settings.muted); };

  /* ================= 音效（纯合成，无音频文件） ================= */
  var audio = WB.audio = (function () {
    var ctx = null, master = null, noiseBuf = null, volume = 0.7, muted = false;

    function ensure() {
      if (ctx) return ctx;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : volume;
      master.connect(ctx.destination);
      // 噪声缓冲（爆炸/碎裂）
      var len = Math.floor(ctx.sampleRate * 0.6);
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return ctx;
    }

    function resume() {
      var c = ensure();
      if (c && c.state === 'suspended') c.resume();
    }

    function tone(freq, dur, type, vol, slideTo, delay) {
      var c = ensure(); if (!c) return;
      var t0 = c.currentTime + (delay || 0);
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(master);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    }

    function noise(dur, vol, filterFreq, delay) {
      var c = ensure(); if (!c) return;
      var t0 = c.currentTime + (delay || 0);
      var src = c.createBufferSource();
      src.buffer = noiseBuf;
      var g = c.createGain();
      var f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(filterFreq || 1200, t0);
      f.frequency.exponentialRampToValueAtTime(180, t0 + dur);
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0); src.stop(t0 + dur + 0.02);
    }

    var SOUNDS = {
      shoot() { tone(520, 0.08, 'square', 0.10, 180); },
      brick() { noise(0.10, 0.22, 2500); },
      spark() { tone(1400, 0.05, 'square', 0.05, 700); },
      ricochet() { tone(1750, 0.05, 'square', 0.06, 1050); noise(0.04, 0.07, 4200); },
      boom() { noise(0.38, 0.42, 900); tone(120, 0.32, 'sawtooth', 0.16, 40); },
      kill() { noise(0.5, 0.5, 800); tone(90, 0.45, 'sawtooth', 0.2, 35); },
      pickup() { tone(660, 0.09, 'triangle', 0.16, 880); tone(880, 0.09, 'triangle', 0.16, 1180, 0.08); tone(1180, 0.12, 'triangle', 0.14, 1400, 0.16); },
      spawn() { tone(300, 0.16, 'triangle', 0.12, 700); },
      count() { tone(760, 0.09, 'square', 0.13); },
      go() { tone(1100, 0.18, 'square', 0.15, 1500); },
      click() { tone(880, 0.05, 'triangle', 0.10, 660); },
      place() { tone(420, 0.06, 'triangle', 0.18, 300); noise(0.05, 0.10, 3000); },
      undo() { tone(400, 0.14, 'sine', 0.16, 180); },
      win() { [523, 659, 784, 1046].forEach(function (f, i) { tone(f, 0.22, 'triangle', 0.16, f, i * 0.11); }); },
      lose() { [440, 370, 294, 220].forEach(function (f, i) { tone(f, 0.26, 'sawtooth', 0.13, f * 0.8, i * 0.13); }); },
      invite() { tone(880, 0.12, 'sine', 0.16); tone(1174, 0.18, 'sine', 0.14, 1174, 0.12); },
      error() { tone(180, 0.16, 'square', 0.12, 120); }
    };

    return {
      resume: resume,
      setVolume(v, m) {
        volume = util.clamp(v, 0, 1);
        muted = !!m;
        if (master) master.gain.value = muted ? 0 : volume;
      },
      get volume() { return volume; },
      get muted() { return muted; },
      play(name, volScale) {
        if (muted || volume <= 0) return;
        var fn = SOUNDS[name];
        if (!fn) return;
        try { fn(); } catch (e) { /* 忽略音频异常 */ }
      }
    };
  })();
  audio.setVolume(settings.sfxVolume, settings.muted);

  /* ================= 通用 UI ================= */
  var ui = WB.ui = {};

  ui.toast = function (msg, type) {
    var box = document.getElementById('wb-toasts');
    if (!box) {
      box = util.el('div', 'wb-toasts');
      box.id = 'wb-toasts';
      document.body.appendChild(box);
    }
    var t = util.el('div', 'wb-toast ' + (type || ''), util.esc(msg));
    box.appendChild(t);
    setTimeout(function () { t.classList.add('out'); }, 2400);
    setTimeout(function () { t.remove(); }, 2900);
  };

  /** 设置弹窗：音效音量 + 键位设置 + 昵称 */
  ui.openSettings = function () {
    if (document.getElementById('wb-settings')) return;
    var s = settings;
    var mask = util.el('div', 'wb-mask');
    mask.id = 'wb-settings';

    var panel = util.el('div', 'wb-dialog');
    panel.innerHTML =
      '<div class="wb-dialog-head"><h3>设置</h3><button class="wb-x" data-close>×</button></div>' +
      '<div class="wb-dialog-body">' +
        '<div class="wb-field"><label>昵称</label><input class="wb-input" id="wb-name" maxlength="12" placeholder="输入昵称" value="' + util.esc(s.name) + '"></div>' +
        '<div class="wb-sec"><h4>音效</h4>' +
          '<div class="wb-row">' +
            '<span class="wb-lbl">音量</span>' +
            '<input type="range" id="wb-vol" min="0" max="100" value="' + Math.round(s.sfxVolume * 100) + '">' +
            '<span class="wb-val" id="wb-volval">' + Math.round(s.sfxVolume * 100) + '%</span>' +
          '</div>' +
          '<div class="wb-row">' +
            '<label class="wb-check"><input type="checkbox" id="wb-mute"' + (s.muted ? ' checked' : '') + '> 静音</label>' +
            '<button class="btn tiny ghost" id="wb-test">试听音效</button>' +
          '</div>' +
        '</div>' +
        '<div class="wb-sec"><h4>键位设置 · 坦克大战</h4>' +
          '<p class="wb-hint">点击按键框后按下新键即可修改（Esc 取消）。坦克可 360° 旋转：<b>↑前进　↓后退　←左转　→右转</b>，开火只有一个键。玩家 1 默认使用方向键，玩家 2 默认使用 W/A/S/D。</p>' +
          '<div class="wb-keys">' +
            keyCol('p1', '玩家 1') +
            keyCol('p2', '玩家 2（本地双人）') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="wb-dialog-foot">' +
        '<button class="btn ghost" id="wb-reset">恢复默认</button>' +
        '<button class="btn primary" id="wb-save">保存并关闭</button>' +
      '</div>';

    mask.appendChild(panel);
    document.body.appendChild(mask);

    function keyCol(player, title) {
      var html = '<div class="wb-keycol"><div class="wb-keycol-title">' + title + '</div>';
      ACTIONS.forEach(function (a) {
        html += '<div class="wb-keyrow"><span>' + a.label + '</span>' +
          '<button class="wb-key" data-player="' + player + '" data-action="' + a.k + '">' +
          util.esc(keys.name(s.keys[player][a.k])) + '</button></div>';
      });
      return html + '</div>';
    }

    function close() { mask.remove(); document.removeEventListener('keydown', onEsc, true); }
    function onEsc(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onEsc, true);

    mask.addEventListener('click', function (e) {
      if (e.target === mask || e.target.hasAttribute('data-close')) close();
    });

    var vol = panel.querySelector('#wb-vol');
    vol.addEventListener('input', function () {
      var v = parseInt(vol.value, 10) / 100;
      panel.querySelector('#wb-volval').textContent = Math.round(v * 100) + '%';
      audio.setVolume(v, panel.querySelector('#wb-mute').checked);
    });
    panel.querySelector('#wb-mute').addEventListener('change', function () {
      audio.setVolume(parseInt(vol.value, 10) / 100, this.checked);
    });
    panel.querySelector('#wb-test').addEventListener('click', function () { audio.play('shoot'); setTimeout(function () { audio.play('pickup'); }, 120); });

    // 键位捕获
    util.$$('.wb-key', panel).forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.classList.contains('capturing')) return;
        var old = btn.textContent;
        btn.classList.add('capturing');
        btn.textContent = '按新键…';
        audio.play('click');
        keys.capture(function (code) {
          btn.classList.remove('capturing');
          if (!code) { btn.textContent = old; return; }
          var player = btn.dataset.player, action = btn.dataset.action;
          var conflict = settingsApi.conflict(player, action, code);
          if (conflict) {
            ui.toast('该键已被「' + (ACTIONS.filter(function (x) { return x.k === conflict; })[0] || {}).label + '」占用', 'err');
            audio.play('error');
            btn.textContent = old;
            return;
          }
          s.keys[player][action] = code;
          btn.textContent = keys.name(code);
          audio.play('click');
        });
      });
    });

    panel.querySelector('#wb-reset').addEventListener('click', function () {
      var name = panel.querySelector('#wb-name').value;
      settingsApi.reset();
      panel.querySelector('#wb-vol').value = Math.round(s.sfxVolume * 100);
      panel.querySelector('#wb-volval').textContent = Math.round(s.sfxVolume * 100) + '%';
      panel.querySelector('#wb-mute').checked = s.muted;
      panel.querySelector('#wb-name').value = name;
      settings.name = name;
      util.$$('.wb-key', panel).forEach(function (btn) {
        btn.textContent = keys.name(s.keys[btn.dataset.player][btn.dataset.action]);
      });
      ui.toast('已恢复默认键位与音量');
    });

    panel.querySelector('#wb-save').addEventListener('click', function () {
      s.name = panel.querySelector('#wb-name').value.trim();
      s.sfxVolume = parseInt(vol.value, 10) / 100;
      s.muted = panel.querySelector('#wb-mute').checked;
      settingsApi.save();
      audio.play('click');
      close();
      ui.toast('设置已保存');
    });
  };

  /* 首次交互解锁音频 */
  ['pointerdown', 'keydown'].forEach(function (evt) {
    window.addEventListener(evt, function once() {
      audio.resume();
      window.removeEventListener(evt, once);
    }, { once: true });
  });

  WB.playerName = function () {
    return settings.name && settings.name.trim() ? settings.name.trim() : ('玩家' + (100 + Math.floor(Math.random() * 900)));
  };
})(window.WB);
