/**
 * 路径约定
 *
 * projectRoot：Yunzai 项目根目录（本插件所在仓库）
 * miaoRoot：miao-plugin 目录，即 plugins/miao-plugin（git submodule）。
 *
 * Yunzai 的插件通过 package.json imports（#miao / #miao.models）引用
 * miao-plugin，所以 plugins/miao-plugin 必须存在，先 git submodule update --init。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

export const projectRoot = path.resolve(here, "..")
export const pluginsRoot = path.join(projectRoot, "plugins")
export const miaoLink = path.join(pluginsRoot, "miao-plugin")

function isMiaoRoot(dir) {
  if (!dir) return false
  try {
    return fs.existsSync(path.join(dir, "components", "Data.js"))
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
 * 返回 plugins/miao-plugin 的真实目录。
 * miao-plugin 是 git submodule，直接存在于 plugins/ 下。
 */
export function resolveMiaoRoot() {
  let real
  try {
    real = fs.realpathSync(miaoLink)
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("plugins/miao-plugin 不存在，请先执行 git submodule update --init")
    }
    throw error
  }

  if (!isMiaoRoot(real)) {
    throw new Error(`plugins/miao-plugin 不是有效的 miao-plugin 目录：${real}`)
  }
  return real
}

export const miaoRoot = resolveMiaoRoot()
