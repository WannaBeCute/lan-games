/* ------------------------------------------------------------------
 *  注意：这个文件不是服务端入口，只是一个「防误点」提示。
 *
 *  真正的服务端在  server.cjs
 *
 *  本文件刻意只使用最古老的 JS 语法（var / try / if），
 *  这样即使被 Windows 脚本宿主（Microsoft JScript）直接打开，
 *  也只会弹出一句人话，而不会出现
 *  「语法错误  800A03EA  Microsoft JScript 编译错误」。
 *
 *  在 Node 下运行本文件时会自动转发到 server.cjs，
 *  因此 `node server/server.js` 依然可用。
 * ------------------------------------------------------------------ */

var GUIDE =
  '这里不是启动入口。\n\n' +
  '正确启动方式：\n' +
  '  1) 双击项目根目录的「启动游戏.bat」  （推荐）\n' +
  '  2) 或在命令行执行：  node platform\\server\\server.cjs\n\n' +
  '启动后浏览器访问： http://localhost:8080';

/* Node 环境：直接转发到真正的服务端 */
if (typeof require === 'function') {
  require('./server.cjs');
} else {
  /* 被 Windows 脚本宿主打开：给出友好提示 */
  try {
    if (typeof WScript !== 'undefined') WScript.Echo(GUIDE);
  } catch (e1) { /* 忽略 */ }
  try {
    if (typeof console !== 'undefined' && console.log) console.log(GUIDE);
  } catch (e2) { /* 忽略 */ }
}
