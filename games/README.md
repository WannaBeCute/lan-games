# 往这个项目里加一个新游戏

> 这是**最小契约**（加个游戏最少要做几件事）。
> 想要**完整接口清单 + 适配清单 + 排错手册**（尤其是"从别的分支/副本导入一个已有游戏"），
> 看 [`docs/新游戏接入与导入技术文档.md`](../docs/新游戏接入与导入技术文档.md)。

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
| `Hub.title` / `Hub.entry` | ✅ | 显示名（主页/日志用）与访问入口，如 `'贪吃蛇'` / `'/snake/'`。`entry` 必须等于 `'/' + 目录名 + '/'`，否则主页链接会指向不存在的前缀 |
| `Hub.card` / `Hub.order` | 建议 | 主页卡片上显示什么：`{ desc, tags: [...], art: 'card.svg' }`，以及卡片排序（数字小的排前面，默认 100）。不声明也能跑，只是卡片会用标题首字当占位图、排在最后 |
| `Hub.hidden` | 可选 | 设成 `true` = **不上主页**（`/api/status` 的 `games` 里没有它），但游戏照常加载、路由照常装配，`/入口/` 依然能直连 —— 给还没做完的游戏留门用（`games/dili` 底力练习器就是这种：暂时不上首页、`/dili/` 直连） |
| `stats()` | 可选 | 返回对象会并进 `/api/status` |
| `busy(client)` | 可选 | 这个人现在在不在**组队**里（在房间 / 联机对局中）。返回 `null` = 闲着，返回 `{ label: '房间 1234' }` = 在忙。好友列表据此给他标「组队中」并禁掉「邀请组队」，也拦住别人发给他的组队邀请。**单人模式不该返回 busy**（玩家没进房间，自然就是闲的） |
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
GuessHub.order = 30;              // 主页卡片顺序（数字小的排前面），默认 100
GuessHub.card = {                 // 主页卡片上的内容与插画，平台只负责渲染
  desc: '1~100 猜一个数，次数越少越厉害。',
  tags: ['单人', '无需联网'],
  art: 'card.svg'                 // 相对自己的入口 = /guess/card.svg；不声明就用标题首字当占位图
};
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
| `WB.Friends` | 好友系统（见下） |
| `WB.Chat` | 聊天控件（左下角常驻，见下） |

### 接入好友系统（可选，强烈建议）

好友关系、聊天、组队邀请都由平台层实现，**所有游戏通用**。页面只要两步就能接上：

```html
<link rel="stylesheet" href="/shared/friends.css">   <!-- 好友面板 / 左下角弹窗 / 聊天小窗 -->
<script src="/shared/friends.js"></script>           <!-- 放在 net.js 之后 -->
```

```js
var net = new WB.Net();
WB.Friends.boot(net);          // 顶栏自动多出「👥 好友」按钮
```

想支持「好友组队邀请免邀请码直达」，再向好友系统登记本游戏的能力（平台因此永远不认识任何游戏名）：

```js
WB.Friends.registerGame({
  name: 'guess',                 // 游戏标识（随邀请发给对方，对方按它跳转）
  label: '猜数字',               // 显示名
  entry: '/guess/',              // 受邀方不在这个页面时的跳转地址
  param: 'join',                 // 跳转时带的参数名
  canInvite: function () {       // 现在能不能发邀请 → { data, text }（返回 null 表示暂不可邀请）
    return room ? { data: { room: room.code }, text: '房间 ' + room.code } : null;
  },
  accept: function (data) {      // 受邀方就在本页面 → 直接入座（例如 net.send({t:'guess.join',...})）
    net.send({ t: 'guess.join', room: data.room });
  }
});
```

受邀方在别的页面时，会跳转到 `entry + '?' + param + '=' + JSON.stringify(data)`，
游戏在自己页面启动时解析该参数即可（坦克的 `?join=`、五子棋的 `?invite=` 就是这么做的）。

> 注意：好友以 **IP** 为身份单位（同一台电脑重开页面、换游戏好友都不丢），
> 所以 `data` 里放"房间号 / 邀请码"这类**当前会话**信息，不要放只能靠连接 id 定位的东西。

### 接入聊天控件（可选，推荐）

左下角的聊天控件（`/shared/chat.css` + `/shared/chat.js`）也是平台通用的：引入两个文件、
启动时 `WB.Chat.boot(net)` 就有「好友」页签（点好友弹私聊小窗）。想再要一个
**房间里所有人可见的频道聊天**，只要在房间的生命周期里调两行：

```js
WB.Chat.boot(net);                                  // 启动时一次

// 建房成功 / 加入房间 / 开局时：
WB.Chat.enterRoom({ game: 'guess', code: room.code, title: '猜数字 · 房间 ' + room.code });

// 退出房间 / 对局结束时：
WB.Chat.leaveRoom();
```

`code` 会被拼成频道 id（`guess:1234`），服务端只校验格式（小写字母/数字/`-`/`_`，冒号分隔），
频道是**临时的**：房间里没人了就回收，聊天记录不落盘。控件的收纳态会**同时**显示最新消息和好友列表，
位置/展开状态刷新页面也不会丢；好友私聊小窗换页面会跟随、手动刷新网页才清空。

---

## 4. 约定与硬约束

- **消息**：一律 JSON 文本帧 `{ t: '前缀.动作', ... }`；前缀用游戏名（`snake.*`），避免和别的游戏撞。
- **零 npm 依赖**：服务端只用 Node 内置模块；前端不用打包器、不引入 npm 前端依赖。
- **不许串门**：只引用自己 `/<名字>/` 下的资源；跨游戏通用代码一律走 `/shared/*`。
- **新增游戏后**：重启服务端，启动日志应出现 `[game] 已装配 <显示名> (N 条消息路由)`；
  主页会**自动多出一张卡片**（内容来自 `Hub.card`，插画来自 `Hub.card.art`）——
  不需要改 `platform/web/index.html`，那里只有一个空容器 `#hubGrid`，卡片全是脚本按 `/api/status` 渲染的。
- **然后跑平台自检**：`node tools/platformtest.js`。它一次查清这几件事：契约有没有漏、
  消息类型和前缀有没有和别的游戏撞、目录名有没有撞平台保留路径、卡片插画在不在、
  主页是不是真的把卡片渲染出来了。新游戏加进来先跑它，再跑 `tools/selftest.js` 等既有自检确认没把平台改坏。
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
   - 静态 Hub.title = '{{中文名}}'、Hub.entry = '/{{name}}/'（entry 必须与目录名一致）
   - 静态 Hub.routes = { '{{name}}.动作': '实例方法名' }（消息类型统一用 {{name}}.* 前缀，
     不要用别的游戏已经用过的前缀，否则两个游戏的消息会互相顶掉）
   - 静态 Hub.order = 30、Hub.card = { desc: '一句话简介', tags: ['标签1','标签2'], art: 'card.svg' }
     （这两项决定主页上那张卡片；不写也能跑，但卡片会缺简介和插画，平台自检也会报出来）
   - 实例方法签名是 (client, msg)；需要就加 stats() / onClose(client) / onRename(client)
   - 只有需要每帧推进的游戏才实现 step(dt) / broadcast(dt)，回合制游戏不要写
2) games/{{name}}/client/index.html —— 页面（可用内联或同目录的 CSS/JS）
3) games/{{name}}/client/card.svg —— 主页卡片插画，600×148 的纯 SVG（不要引外部图片、不要脚本）
4) games/{{name}}/client/ 下的其他资源（可选）；需要前后端共用内核时才建 games/{{name}}/shared/

【硬约束】
- 服务端零 npm 依赖，只用 Node 内置模块；前端不用打包器，用传统 <script> + 全局命名空间。
- 前端联网用 new WB.Net()：net.on('类型', fn) 收消息、net.send({t:'类型',...}) 发消息（库已处理同源 /ws 与自动重连）。
- 页面 CSS/JS 只引用自己 /{{name}}/ 下的资源；通用样式用 /shared/app.css（可选）。
- 消息一律是 JSON 文本帧 { t: '类型', ... }；中文注释解释"为什么"，风格与仓库其余部分一致。
- 不要修改 platform/ 下任何文件，也不要碰 games/ 下已存在的其他游戏。

【完成标准】
- 重启服务端（node platform/server/server.cjs）后，启动日志出现 `[game] 已装配 {{中文名}} (N 条消息路由)`，
  并且**没有任何 `[route conflict]` / `[game warn]` 输出**；
- `node tools/platformtest.js` 全部通过（它会检查契约、消息前缀有没有撞车、卡片插画在不在、主页有没有渲染出卡片）；
- 浏览器打开 /{{name}}/ 能玩，核心玩法跑通，控制台无报错；
- 打开主页 / 能看到自己这张卡片（标题、简介、标签、插画都在）。
```

> 小技巧：把「游戏设定」换成更有画面感的描述（比如"双人对战的井字棋，轮到谁就高亮谁，
> 赢一局记一分"），产出会更贴近你想要的样子。要联机的游戏，记得在 `room.js` 里用
> `ctx.clients` / `客户端 id` 做房间管理，并把"权威判定放服务端、客户端只负责显示"。
