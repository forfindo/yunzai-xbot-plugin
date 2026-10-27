/**
 * 路径约定
 *
 * projectRoot：Yunzai 项目根目录（本插件所在仓库）
 * miaoRoot：miao-plugin 目录。优先使用已经存在的 plugins/miao-plugin，
 *           否则使用 MIAO_PLUGIN_DIR，再否则使用同级目录 ../miao-xbot-plugin。
 *
 * Yunzai 的插件通过 package.json imports（#miao / #miao.models）引用
 * miao-plugin，所以 plugins/miao-plugin 必须可解析。目录不存在时这里会
 * 自动创建 junction / symlink 指向 miao-plugin，不会复制任何文件。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

export const projectRoot = path.resolve(here, "..")
export const pluginsRoot = path.join(projectRoot, "plugins")
export const miaoLink = path.join(pluginsRoot, "miao-plugin")
export const tempRoot = path.join(projectRoot, "temp")
export const storeFile = path.join(projectRoot, "data", "miao-plugin", "store.json")

function isMiaoRoot(dir) {
  if (!dir) return false
  try {
    return (
      fs.existsSync(path.join(dir, "components", "Data.js")) &&
      fs.existsSync(path.join(dir, "xopenbot.js"))
    )
  } catch {
    return false
  }
}

/**
 * 切换到项目根目录。
 * Yunzai 的配置、插件、模板、日志全部使用相对 process.cwd() 的路径，
 * 宿主从其它目录启动时必须切换。整个进程只会切换一次。
 */
export function chdirProjectRoot() {
  if (path.resolve(process.cwd()) === projectRoot) return false
  process.chdir(projectRoot)
  return true
}

/**
 * 确保 plugins/miao-plugin 存在并返回 miao-plugin 的真实目录。
 */
export function resolveMiaoRoot() {
  try {
    const real = fs.realpathSync(miaoLink)
    if (isMiaoRoot(real)) return real
    throw new Error(`plugins/miao-plugin 已存在，但不是 miao-plugin 目录：${real}`)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }

  const candidates = []
  if (process.env.MIAO_PLUGIN_DIR) candidates.push(path.resolve(process.env.MIAO_PLUGIN_DIR))
  candidates.push(path.resolve(projectRoot, "..", "miao-xbot-plugin"))

  const target = candidates.find(isMiaoRoot)
  if (!target) {
    throw new Error(
      "未找到 miao-plugin。请将 miao-xbot-plugin 放在本项目的同级目录，" +
        "或设置环境变量 MIAO_PLUGIN_DIR 指向 miao-plugin 目录。",
    )
  }

  fs.mkdirSync(pluginsRoot, { recursive: true })
  fs.symlinkSync(target, miaoLink, process.platform === "win32" ? "junction" : "dir")
  return fs.realpathSync(miaoLink)
}

export const miaoRoot = resolveMiaoRoot()
