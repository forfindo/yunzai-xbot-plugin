/**
 * miao-plugin 的 components/Data.js 内部直接调用闭包里的 getRoot，
 * 只替换 Data.getRoot 不会影响 readJSON / importModule 等方法。
 * 这里用相同签名重写这些方法，让它们统一走 Data.getRoot。
 *
 * 与 miao-plugin 独立运行时的区别：Yunzai 下根目录就是本项目根目录，
 * miao 数据目录为 plugins/miao-plugin（指向同级 miao-plugin 的链接）。
 */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { projectRoot, miaoRoot } from "./paths.js"

function rootOf(Data, root) {
  return Data.getRoot(root)
}

function fullPath(Data, root, file) {
  return path.join(rootOf(Data, root), String(file).replace(/^[/\\]+/, ""))
}

export function installDataRoot(Data) {
  if (!Data) return false
  Data.getRoot = function (root = "") {
    if (!root || root === "root" || root === "yunzai") return `${projectRoot}/`
    if (root === "miao") return `${miaoRoot}/`
    return `${path.join(projectRoot, "plugins", root)}/`
  }
  Data.__xopenbotDataRoot = true
  return true
}

export function patchData(Data) {
  if (!Data || Data.__xopenbotPatched) return false

  Data.createDir = function (dir = "", root = "", includeFile = false) {
    const target = path.join(rootOf(this, root), String(dir).replace(/^[/\\]+/, ""))
    const mkdir = includeFile ? path.dirname(target) : target
    if (mkdir) fs.mkdirSync(mkdir, { recursive: true })
  }

  Data.readJSON = function (file = "", root = "") {
    const target = fullPath(this, root, file)
    if (!fs.existsSync(target)) return {}
    try {
      return JSON.parse(fs.readFileSync(target, "utf8"))
    } catch (error) {
      console.error(`JSON数据错误: ${target}`)
      console.error(error)
      return {}
    }
  }

  Data.writeJSON = function (cfg, data, root = "", space = 2) {
    if (arguments.length > 1) {
      return this.writeJSON({ name: cfg, data, space, root })
    }
    const name = cfg.path ? `${cfg.path}/${cfg.name}` : cfg.name
    this.createDir(name, cfg.root, true)
    const target = fullPath(this, cfg.root, name)
    const output = JSON.stringify(cfg.data, null, cfg.space || 2)
    return fs.writeFileSync(target, cfg.rn ? output.replaceAll("\n", "\r\n") : output)
  }

  Data.delFile = function (file, root = "") {
    const target = fullPath(this, root, file)
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target)
      return true
    } catch (error) {
      globalThis.logger?.error?.(`文件删除失败：${error}`)
      return false
    }
  }

  Data.importModule = async function (file, root = "") {
    let target = fullPath(this, root, file)
    if (!/\.js$/.test(target)) target += ".js"
    if (!fs.existsSync(target)) return {}
    try {
      const url = `${pathToFileURL(target).href}?t=${Date.now()}`
      return (await import(url)) || {}
    } catch (error) {
      console.error(`import module错误: ${target}`)
      console.error(error)
      return {}
    }
  }

  Data.importDefault = async function (file, root) {
    const ret = await this.importModule(file, root)
    return ret.default || {}
  }

  Data.importCfg = async function (key) {
    let sysCfg = await this.importModule(`config/system/${key}_system.js`, "miao")
    let diyCfg = await this.importModule(`config/${key}.js`, "miao")
    if (diyCfg.isSys) {
      console.error(`miao-plugin: config/${key}.js无效，已忽略`)
      console.error(
        `如需配置请复制config/${key}_default.js为config/${key}.js，请勿复制config/system下的系统文件`,
      )
      diyCfg = {}
    }
    return { sysCfg, diyCfg }
  }

  Data.__xopenbotPatched = true
  return true
}
