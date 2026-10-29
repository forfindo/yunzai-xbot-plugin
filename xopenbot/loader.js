/**
 * 通用加载 plugins/** 下的 Yunzai 插件。
 *
 * 规则与 lib/plugins/loader.js 保持一致：
 * - 插件目录下存在 index.js 时只加载 index.js
 * - 否则加载目录下所有 .js 文件
 * - 导出对象中的每个 class 都会被实例化，读取 name / priority
 * - 插件 init() 返回 'return' 时跳过
 *
 * plugins/miao-plugin 由 miao-plugin 自己的 @xopenbot/plugin 入口负责，
 * 这里必须跳过，否则 miao 的命令会被注册两次。
 */
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { projectRoot, pluginsRoot } from "./paths.js"

const DEFAULT_PRIORITY = 5000

function log() {
  return globalThis.logger || console
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function collectFiles() {
  const entries = await fs.readdir(pluginsRoot, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === "miao-plugin") continue

    const dir = path.join(pluginsRoot, entry.name)
    const index = path.join(dir, "index.js")
    if (await exists(index)) {
      files.push({ name: entry.name, path: index })
      continue
    }

    const apps = await fs.readdir(dir, { withFileTypes: true })
    for (const app of apps) {
      if (!app.isFile() || !app.name.endsWith(".js")) continue
      files.push({
        name: `${entry.name}/${app.name}`,
        path: path.join(dir, app.name),
      })
    }
  }

  return files
}

async function loadFile(file) {
  let app
  try {
    app = await import(pathToFileURL(file.path).href)
  } catch (error) {
    log().error?.(`加载插件错误：${log().red?.(file.name) ?? file.name}`)
    log().error?.(error?.stack || error)
    return { plugins: [], tasks: [] }
  }

  if (app?.apps) app = { ...app.apps }

  const plugins = []
  const tasks = []
  for (const entry of Object.values(app || {})) {
    if (!entry?.prototype) continue
    try {
      const instance = new entry()
      if (typeof instance.init === "function" && (await instance.init()) === "return") continue
      plugins.push({
        class: entry,
        key: file.name,
        name: instance.name || entry.name || file.name,
        priority: Number.isFinite(instance.priority) ? instance.priority : DEFAULT_PRIORITY,
      })
      for (const task of Array.isArray(instance.task) ? instance.task : [instance.task]) {
        if (task?.cron && task?.name && typeof task?.fnc === "function") tasks.push(task)
      }
    } catch (error) {
      log().error?.(`加载插件错误：${log().red?.(file.name) ?? file.name}`)
      log().error?.(error?.stack || error)
    }
  }
  return { plugins, tasks }
}

/**
 * @returns {Promise<{priority: Array, tasks: Array, files: number, count: number}>}
 */
export async function loadPlugins() {
  const files = await collectFiles()
  const priority = []
  const tasks = []

  log().info?.("-----------")
  log().info?.("加载插件中...")

  for (const file of files) {
    const { plugins, tasks: fileTasks } = await loadFile(file)
    priority.push(...plugins)
    tasks.push(...fileTasks)
  }

  priority.sort((a, b) => a.priority - b.priority)

  log().info?.(`加载插件[${priority.length}个]`)
  log().info?.(`加载定时任务[${tasks.length}个]`)
  return { priority, files: files.length, count: priority.length, tasks }
}

export { projectRoot }
