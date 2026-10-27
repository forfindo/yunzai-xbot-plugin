# Miao-Yunzai 的 @xopenbot/plugin 适配

把本仓库 `plugins/**` 下的全部 Yunzai 命令注册成 openbot 命令，并通过
`IPlugin.init()` 向同一个 Workspace 中的 [miao-plugin](https://github.com/Yoimiya-Kokomi/miao-plugin)
提供宿主能力。

## 使用

```js
import { Workspace } from '@xopenbot/plugin'
import YunzaiPlugin from 'file:///D:/IDEAProject/yunzai-xbot-plugin/xopenbot.js'
import MiaoPlugin from 'file:///D:/IDEAProject/miao-xbot-plugin/xopenbot.js'

Workspace.registry([YunzaiPlugin, MiaoPlugin])
```

两个插件可以按任意顺序注册：

- `miao-yunzai` 命令优先级 `9000`，先于 `miao-plugin`（`9999`）执行
- 没有命中任何 Yunzai 命令时返回 `{ next: true }`，消息继续交给 miao-plugin
- 命中后停止，避免同一条消息被两个插件重复处理

`@xopenbot/plugin` 只是宿主的类型/工作区实现，本适配层不 import 它，
因此不需要把它加入本仓库依赖。

### 目录约定

- 默认要求 `miao-plugin` 位于本项目的同级目录：`../miao-xbot-plugin`
- 也可以用环境变量 `MIAO_PLUGIN_DIR` 指定
- 若 `plugins/miao-plugin` 不存在，会自动创建指向上述目录的 junction / symlink
  （Yunzai 插件通过 package.json 的 `#miao` / `#miao.models` 引用它）
- 如果 `plugins/miao-plugin` 已经是真实目录（例如原版 Miao-Yunzai），直接使用

### 工作目录

导入本模块会把 `process.cwd()` 切换到 Yunzai 项目根目录。
Yunzai 的配置、插件、模板、日志都使用相对路径，宿主从其它目录启动时这是必须的。
请确保宿主其它模块不要在导入后依赖原来的 cwd。

## init() 提供的能力

`Workspace` 会把 `init()` 的返回值浅合并进每个命令的 `ctx`，当前提供：

| 能力 | 说明 |
| --- | --- |
| `runtime.render(plugin, tpl, params, options)` | 使用项目自带 puppeteer 渲染 miao-plugin 模板；支持 `beforeRender`、`scale`、`retType` |
| `runtime.getUid(e)` | `MysInfo.getUid` |
| `runtime.getMysInfo(targetType, e)` | `MysInfo.init`，`cookie` 模式对应 `detail` |
| `runtime.getMysApi(targetType, option, isSr, e)` | 返回 `MysApi` 或 `false` |
| `runtime.createMysApi(uid, ck, option, isSr)` | 直接构造 `MysApi` |
| `runtime.user` | 当前消息用户的 `NoteUser`（同步 getter） |
| `runtime.NoteUser` / `MysUser` / `MysInfo` / `gsCfg` | 模型与配置 |
| `host.*` | 同上的副本，供只读取 `ctx.host` 的宿主使用 |

`runtime.user` 由本次消息的 `Runtime.init(e)` 填充。`miao-yunzai` 先于
`miao-plugin` 执行，因此 miao 读取 `e.runtime.user` 时能拿到正确的用户。
如果宿主只注册了 miao-plugin，未调用本插件，`runtime.user` 会返回一个空的
兼容对象（`getCkUidList()` 返回 `[]`，`hasCk` 为 `false`）。

### ctx.host 补齐

`Workspace` 用浅合并构造 ctx，每条消息的 `ctx.host` 会覆盖 `init()` 里的
`host`，但对象引用保持不变。因此分发时会就地补齐当前 `ctx.host`：

- `render` / `getUid` / `getMysInfo` / `getMysApi` / `createMysApi`（缺失时）
- `getHistory` / `getForward` / `getMemberMap` / `getMember`（宿主未实现时降级）
- 群成员列表会在命令执行前预热一次，供同步 API `e.bot.gml` / `e.group.pickMember` 使用

## 加载与分发

- 通用加载 `plugins/**`（跳过 `miao-plugin`）：有 `index.js` 时只加载它，否则加载目录下所有 `.js`
- 复刻 Yunzai v3 loader 语义：冷切、黑白名单、`onlyReplyAt`、botAlias、星铁/绝区零前缀、`getContext`、`accept`、`rule`/`permission`、`disable`/`enable`
- 每次事件重新实例化插件，`e.runtime` 由 `lib/plugins/runtime.js` 注入
- `e.reply` 直接通过 `ctx.host.send` 发送；宿主没有 `send` 时收集为 `content` 返回

## 存储

宿主未提供 `ctx.host.redis` 时使用本地 JSON 存储：

```text
<projectRoot>/data/miao-plugin/store.json
```

与 miao-plugin 独立运行时的默认目录一致，两个插件可以共享 UID / CK 绑定。
如果 miao-plugin 的适配层先加载并安装了 `global.redis`，本插件会直接复用它。

## 已知限制

- `process.cwd()` 会被修改
- `request` / `notice` 事件依赖宿主在 ctx 中提供 `post_type` / `noticeType` / `subType`
- 宿主未实现的能力（主动私聊、群发、退群、处理请求、撤回等）会记录日志并返回 `false`
- 不支持 Yunzai 的插件热更新与定时任务（本仓库当前没有插件使用它们）
- 插件之间的全局状态（`global.logger` / `global.redis` / `global.plugin`）与同进程内的其它插件共享
