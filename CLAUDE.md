# Miao-Yunzai（yunzai-xbot-plugin）

Miao-Yunzai（Yunzai 的 fork）QQ 群机器人。`xopenbot/` 是把它的命令能力适配成 `@xopenbot/plugin` 插件的适配层。
两种运行：独立（`app.js` → `lib/bot.js`）、插件模式（根 `xopenbot.js`）。

下面按**最容易出错的地方**组织，改代码前先读。

## 1. 适配层只做适配，不要重实现项目已有能力

`xopenbot/` 的职责是「把 Miao-Yunzai 原生处理命令的能力转成插件能力」，不是另起一套。存储、渲染、配置一律复用 `lib/`。

- 反例（踩过的坑）：曾写 `xopenbot/store.js` 本地 JSON store 兜底，**已删**。存储只用 `global.redis`（`lib/config/redis.js` 的 `redisInit()` 设置）。
- 渲染只用 `lib/renderer/loader.js` 的 `RendererLoader`；`lib/puppeteer/puppeteer.js` 只是它的壳。
- 往适配层加能力前，先确认 `lib/` 里没有现成的。

## 2. 插件模式不走 lib/config/init.js，初始化要手动补齐

独立运行靠 `lib/bot.js` 顶部 `import "./config/init.js"`（`checkInit()` 里 `redisInit()` 设 `global.redis`）。
但插件模式只走 `xopenbot.js` → `xopenbot/bootstrap.js`，**不会**执行 `checkInit`。

所以 `bootstrap()` 必须按序手动补齐（见 `xopenbot/bootstrap.js`）：chdir → logger/segment/Bot → Data patch → plugin base → config → **redisInit()** → renderer → loadPlugins → dispatch。
漏了 `redisInit()` 就会 `global.redis` 为空、命令层崩——这正是当年写 store 的根因。

## 3. 两套 loader 是并行的，别混

- 独立运行用 `lib/plugins/loader.js`（icqq 消息分发）。
- 插件模式用 `xopenbot/loader.js` + `xopenbot/dispatch.js`（复刻前者 `deal()` 语义）。

改其中一个不会自动同步到另一个。涉及 `plugin.task` 收集、`plugin.handler` 注册这类能力时，两套都要看。

## 4. plugins/miao-plugin 是 junction，不是真目录

由 `xopenbot/paths.js` 的 `resolveMiaoRoot()` 自动建，指向同级 `../miao-xbot-plugin`（可用 `MIAO_PLUGIN_DIR` 覆盖）。
因为 `package.json` 的 `#miao` / `#miao.models` imports 写死 `./plugins/miao-plugin/...`，Yunzai 存量代码（如 `lib/plugins/runtime.js`）依赖它。

- 别往里复制文件，也别当普通目录删（删了下次 import 会重建）。
- `xopenbot/loader.js` 会**跳过** `miao-plugin`，它的命令由兄弟仓库 `miao-xbot-plugin` 自己的 `xopenbot.js` 注册——要它生效，宿主得同时注册两个插件。

## 5. 扩展点状态：定时任务已接，handler 未接

- **定时任务（已接）**：宿主接口 `getScheduleTask()`。`xopenbot/loader.js` 收集 `instance.task`（`{ cron, name, fnc, log }`），根 `xopenbot.js` 映射成宿主 `ScheduleTask`，`fnc()` 成功返 true、失败返 false。cron 直接透传，两边都是 `node-schedule`，格式兼容。
- **plugin.handler（未接）**：`lib/plugins/handler.js` 的按 key 分组的 hooks 注册表。注册靠 loader 的 `Handler.add`，触发靠 `e.runtime.handler`。全生态目前只有 `plugins/genshin/model/mys/mysInfo.js` 的 `"mys.req.err"` **一处触发、零注册**。适配层 `xopenbot/loader.js` 还没加 `Handler.add`——眼下无影响，将来有插件声明 `handler` 时就得补。

## 其它坑

- `bootstrap()` 会 `process.chdir(projectRoot)`；Yunzai 大量用相对路径，宿主若依赖原 cwd 需注意。
- 提交前跑 `pnpm lint`（prettier 全量格式化 `git ls-files '*.js'`）。
- `redisInit()` 连不上会尝试 daemonize 起 `redis-server`、再失败就 `process.exit()`，是原生语义，适配层复用时照单全收。
