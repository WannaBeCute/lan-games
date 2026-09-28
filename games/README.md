# 往这个项目里加一个新游戏

## 一句话

**在 `games/` 下新建一个文件夹就行** —— 平台层（`platform/`）一行都不用改，也不用"注册"。
重启服务端时会自动发现并挂载。

---

## 1. 目录约定

```
games/<名字>/
├─ client/            index.html + 该游戏所有前端资源（CSS / JS / 图片），由平台挂到 /<名字>/
├─ shared/            （可选）「浏览器 + Node 共用」的内核，挂到 /<名字>/shared/
└─ server/room.js     服务端逻辑 —— 唯一的必需文件，没有它平台就不会发现这个游戏
```

- 目录名（英文，如 `snake`）就是它的 URL 前缀：`/snake/`。
- 只有需要"前后端共用同一份物理/规则代码"的游戏才建 `shared/`（坦克的 `tankcore.js` 就是这种）。
- 平台会自动挂载：`/<名字>/` → `client/`，`/<名字>/shared/` → `shared/`（存在才挂）。

---

## 2. 服务端契约（`games/<名字>/server/room.js`）

导出（`module.exports`）一个 **Hub 类**：

| 约定 | 必需 | 说明 |
| --- | --- | --- |
| `new Hub(ctx)` | ✅ | `ctx` 提供：`ctx.send(client, obj)`、`ctx.clients`(Map)、`ctx.findByInviteCode(code)`、`ctx.listOnline()` |
| `Hub.routes = { '前缀.动作': '方法名' }` | ✅ | 平台据此把你的消息路由进来；`t` 不在表里的消息不会被处理 |
| 实例方法 `方法名(client, msg)` | ✅ | `client` = `{ id, name, ip, inviteCode, ... }`，`msg` = 收到的 JSON 对象 |
| `Hub.title` / `Hub.entry` | 建议 | 显示名（主页/日志用）与访问入口，如 `'贪吃蛇'` / `'/snake/'` |
| `stats()` | 可选 | 返回对象会并进 `/api/status` |
| `onClose(client)` / `onRename(client)` | 可选 | 玩家断线 / 改昵称时被调用 |
| `step(dt)` / `broadcast(dt)` | 可选 | **只有需要每帧推进的游戏才实现**（如坦克）；回合制游戏不要写 |

### 最小可运行模板（猜数字）

```js
'use strict';
// games/guess/server/room.js
class GuessHub {
  constructor(ctx) { this.ctx = ctx; this.rooms = new Map(); }
  stats() { return { guessRooms: this.rooms.size }; }

  start(client) {
    const secret = 1 + Math.floor(Math.random() * 100);
    this.rooms.set(client.id, { secret, tries: 0 });
    this.ctx.send(client, { t: 'guess.state', hint: '1~100 猜一个数', tries: 0 });
  }
  guess(client, msg) {
    const r = this.rooms.get(client.id);
    if (!r) return;
    const n = parseInt(msg.n, 10);
    r.tries++;
    const hint = n === r.secret ? '中啦！' : (n < r.secret ? '小了' : '大了');
    this.ctx.send(client, { t: 'guess.state', hint, tries: r.tries, win: n === r.secret });
  }
  onClose(client) { this.rooms.delete(client.id); }
}

GuessHub.title = '猜数字';
GuessHub.entry = '/guess/';
GuessHub.routes = { 'guess.start': 'start', 'guess.guess': 'guess' };

module.exports = GuessHub;
```

---

## 3. 客户端契约（`games/<名字>/client/index.html`）

页面直接放在 `client/` 里，用**传统 `<script>` 标签**引入平台通用库即可：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>猜数字</title>
<link rel="stylesheet" href="/shared/app.css">   <!-- 通用样式，可选 -->
</head>
<body>
<div class="topbar"><div class="brand"><a href="/">机房小游戏</a><span class="crumb">/ 猜数字</span></div></div>

<h1>猜 1~100</h1>
<input id="n" type="number"><button id="go">猜</button><p id="hint"></p>

<script src="/shared/core.js"></script>   <!-- window.WB：设置/音效/toast/键位 -->
<script src="/shared/net.js"></script>    <!-- window.WB.Net：WebSocket 客户端 -->
<script>
  var net = new WB.Net();                                  // 自动连 同源 /ws，自动重连
  net.on('guess.state', function (m) {
    document.getElementById('hint').textContent = m.hint + '（第 ' + m.tries + ' 次）';
  });
  net.connect();
  document.getElementById('go').onclick = function () {
    net.send({ t: 'guess.start' });                        // 首次进入可先 start
    net.send({ t: 'guess.guess', n: +document.getElementById('n').value });
  };
</script>
</body>
</html>
```

### 平台已提供的通用能力（不用自己造）

| 全局对象 | 用途 |
| --- | --- |
| `WB.Net` | WebSocket 客户端：`new WB.Net()` → `.on(type, fn)` / `.send(obj)` / `.connect()`（同源 `/ws`，自动重连、RTT 统计） |
| `WB.settings` | 昵称 / 音效音量 / 键位，存 localStorage，`window.addEventListener('wb:settings', ...)` 监听变化 |
| `WB.audio` | 纯 WebAudio **现场合成**音效（`WB.audio.play('shoot')` 等），无音频文件 |
| `WB.ui` | `WB.ui.toast(msg)`、设置弹窗 `WB.ui.openSettings()` |
| `WB.keys` | 键盘捕获与"点一下再按新键"的改键 |
| `/shared/app.css` | `.btn` `.panel` `.topbar` `.net-badge` 等通用样式 |

---

## 4. 约定与硬约束

- **消息**：一律 JSON 文本帧 `{ t: '前缀.动作', ... }`；前缀用游戏名（`snake.*`），避免和别的游戏撞。
- **零 npm 依赖**：服务端只用 Node 内置模块；前端不用打包器、不引入 npm 前端依赖。
- **不许串门**：只引用自己 `/<名字>/` 下的资源；跨游戏通用代码一律走 `/shared/*`。
- **新增游戏后**：重启服务端，启动日志应出现 `[game] 已装配 <显示名> (N 条消息路由)`；
  然后跑一遍现有自检（`node tools/selftest.js` 等）确认没把平台改坏。
- `.bat` 必须是 CRLF（仓库已用 `.gitattributes` 兜底）；测试脚本放 `tools/`。

---

## 5. 给"同学 / AI"的提示词（可直接复制）

把下面整段发出去，把 `{{...}}` 换成你的游戏设定即可：

```text
你正在往一个已有的「机房小游戏」仓库里加一个新游戏。请**严格遵守**它的既有约定，
**不要改动 platform/ 目录**（那是平台层，与具体游戏无关）。

【项目结构】
- platform/server/server.cjs   平台主机：静态服务 + 装配游戏 + 通用消息 + 主循环。
- platform/web/shared/         跨游戏通用库：core.js(window.WB) / net.js(window.WB.Net) / app.css
- games/<名字>/                一个游戏一个文件夹（你要新建的就是这里），平台会自动发现并挂载

【游戏设定】
- 英文目录名：{{name}}
- 显示名：{{中文名}}
- 玩法：{{一句话说清玩法与胜负条件}}
- 操作：{{键鼠操作}}

【要产出的文件（严格按此结构）】
1) games/{{name}}/server/room.js —— 服务端逻辑，导出一个类 Hub：
   - 构造函数接收 ctx（含 ctx.send(client, obj) / ctx.clients / ctx.findByInviteCode(code)）
   - 静态 Hub.title = '{{中文名}}'、Hub.entry = '/{{name}}/'
   - 静态 Hub.routes = { '{{name}}.动作': '实例方法名' }（消息类型统一用 {{name}}.* 前缀）
   - 实例方法签名是 (client, msg)；需要就加 stats() / onClose(client) / onRename(client)
   - 只有需要每帧推进的游戏才实现 step(dt) / broadcast(dt)，回合制游戏不要写
2) games/{{name}}/client/index.html —— 页面（可用内联或同目录的 CSS/JS）
3) games/{{name}}/client/ 下的其他资源（可选）；需要前后端共用内核时才建 games/{{name}}/shared/

【硬约束】
- 服务端零 npm 依赖，只用 Node 内置模块；前端不用打包器，用传统 <script> + 全局命名空间。
- 前端联网用 new WB.Net()：net.on('类型', fn) 收消息、net.send({t:'类型',...}) 发消息（库已处理同源 /ws 与自动重连）。
- 页面 CSS/JS 只引用自己 /{{name}}/ 下的资源；通用样式用 /shared/app.css（可选）。
- 消息一律是 JSON 文本帧 { t: '类型', ... }；中文注释解释"为什么"，风格与仓库其余部分一致。
- 不要修改 platform/ 下任何文件，也不要碰 games/ 下已存在的其他游戏。

【完成标准】
- 重启服务端（node platform/server/server.cjs）后，启动日志出现 `[game] 已装配 {{中文名}} (N 条消息路由)`；
- 浏览器打开 /{{name}}/ 能玩，核心玩法跑通，控制台无报错。
```

> 小技巧：把「游戏设定」换成更有画面感的描述（比如"双人对战的井字棋，轮到谁就高亮谁，
> 赢一局记一分"），产出会更贴近你想要的样子。要联机的游戏，记得在 `room.js` 里用
> `ctx.clients` / `客户端 id` 做房间管理，并把"权威判定放服务端、客户端只负责显示"。
