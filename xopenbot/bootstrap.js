/**
 * 初始化顺序很重要：
 *
 * 1. 切换 cwd 到项目根目录（Yunzai 大量使用相对路径）
 * 2. 补齐 logger / redis / segment / Bot
 * 3. 在加载 #miao 之前重定向 Data.getRoot 等读写方法
 * 4. 设置 global.plugin（Yunzai 插件基类）
 * 5. 加载渲染后端、plugins/**、以及宿主能力
 *
 * 本文件只静态引用 node 内置模块，其它模块全部动态 import，
 * 保证 globals / Data patch 在它们求值之前完成。
 */
import fs from "node:fs"
import path from "node:path"
import { chdirProjectRoot, projectRoot, miaoRoot } from "./paths.js"

function log() {
  return globalThis.logger || console
}

async function setupLogger(globals) {
  globals.installGlobals()

  try {
    const { default: setLog } = await import("../lib/config/log.js")
    setLog()
  } catch (error) {
    console.warn("[miao-yunzai] 日志初始化失败，使用控制台输出", error)
  }

  // setLog 可能替换了 logger，补齐 miao / 插件会用到的方法
  const { installGlobals } = await import("./globals.js")
  installGlobals()
}

async function setupData() {
  // Data.js 本身只读取 #miao.path，不会触发配置加载
  const { default: Data } = await import("../plugins/miao-plugin/components/Data.js")
  const { installDataRoot, patchData } = await import("./data-patch.js")
  installDataRoot(Data)
  patchData(Data)
  return Data
}

async function setupPluginBase() {
  const { default: Plugin } = await import("../lib/plugins/plugin.js")
  globalThis.plugin = Plugin
  return Plugin
}

async function setupRenderer(configureRuntime) {
  try {
    const { default: RendererLoader } = await import("../lib/renderer/loader.js")
    configureRuntime({ renderer: RendererLoader.getRenderer() })
    return RendererLoader
  } catch (error) {
    log().error?.("[miao-yunzai] 渲染后端加载失败，图片命令将不可用", error)
    return null
  }
}

function readPackage() {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"))
  } catch {
    return { name: "miao-yunzai", version: "unknown" }
  }
}

export async function bootstrap() {
  chdirProjectRoot()

  const globals = await import("./globals.js")
  await setupLogger(globals)

  log().info?.("[miao-yunzai] 项目目录", projectRoot)
  log().info?.("[miao-yunzai] miao-plugin", miaoRoot)

  await setupData()
  await setupPluginBase()

  // 确保配置文件 / 目录初始化完成
  await import("../lib/config/config.js")

  const { configureRuntime, createInitApis } = await import("./runtime.js")
  await setupRenderer(configureRuntime)

  const { loadPlugins } = await import("./loader.js")
  const { priority } = await loadPlugins()

  const { createDispatch } = await import("./dispatch.js")
  const dispatch = createDispatch(priority)

  const pkg = readPackage()
  const command = {
    name: "miao-yunzai",
    // 空匹配，实际命令由 Yunzai loader 语义在 dispatch 中匹配
    pattern: /(?:)/,
    // 早于 miao-plugin（9999）执行；未命中时返回 next 交给后续插件
    priority: 9000,
    execute: (input, ctx) => dispatch(ctx?.raw_message ?? input, ctx),
  }

  return {
    command,
    apis: createInitApis(),
    info: {
      name: "miao-yunzai",
      version: pkg.version || "unknown",
      description: "Yunzai 插件适配：加载 plugins/** 下的全部命令",
    },
    priority,
  }
}
