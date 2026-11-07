import fs from "node:fs"
import path from "node:path"
import { chdirProjectRoot, projectRoot, miaoRoot } from "./xopenbot/paths.js"

chdirProjectRoot()

const pkg = readPackage()

function readPackage() {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"))
  } catch {
    return { name: "miao-yunzai", version: "unknown" }
  }
}

const plugin = {
  info: {
    name: "miao-yunzai",
    version: pkg.version || "unknown",
    description: "Yunzai 插件适配：加载 plugins/** 下的全部命令",
  },
  async init({bot}) {
    // 初始化配置
    await import("./xopenbot/init.js");
    const {default: cfg} = await import("./lib/config/config.js");
    bot[bot.uin] = bot;
    globalThis.Bot = bot;
    const {default: plugins} = await import("./lib/plugins/loader.js");
    const originGetPlugins = plugins.getPlugins.bind(plugins);
    plugins.getPlugins = async function () {
      const ret = await originGetPlugins();
      return ret.filter(item => ![
        'example/进群退群通知.js',
        'other/restart.js',
        'other/update.js',
        'system/disablePrivate.js',
        'system/friend.js',
        'system/invite.js',
        'system/quit.js',
        'system/status.js'
      ].includes(item.name))
    }
    await plugins.load();
  },
  async loadCommand() {
    const {default: plugins} = await import("./lib/plugins/loader.js");
    return [
      {
        name: "miao-yunzai",
        // 空匹配，实际命令由 Yunzai loader 语义在 deal 中匹配
        pattern: /(?:)/,
        priority: 100,
        execute: async (input, ctx) => await plugins.deal({
          ...ctx
        })
      }
    ]
  }
}

export default plugin
export { plugin }
