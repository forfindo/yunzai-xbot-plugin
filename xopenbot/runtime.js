/**
 * 通过 IPlugin.init() 返回给 @xopenbot/plugin 的宿主能力。
 *
 * 这些能力与 Yunzai 的 lib/plugins/runtime.js 对齐，并额外遵循
 * miao-plugin/xopenbot/HOST.md 的约定：
 * - 末位可选参数 e 表示当前消息，用于多用户 / 多游戏场景
 * - render 支持 beforeRender，返回 Buffer / base64
 * - 提供 NoteUser / MysUser / MysInfo / gsCfg / createMysApi
 *
 * 因为 Workspace 会用浅合并把 init 返回值放到 ctx，而每条消息的 ctx.host
 * 会覆盖 init 里的 host，所以 dispatch 会把 render 等方法补到当前 ctx.host 上。
 */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { miaoRoot } from "./paths.js"
import NoteUser from "../plugins/genshin/model/mys/NoteUser.js"
import MysUser from "../plugins/genshin/model/mys/MysUser.js"
import MysInfo from "../plugins/genshin/model/mys/mysInfo.js"
import MysApi from "../plugins/genshin/model/mys/mysApi.js"
import gsCfg from "../plugins/genshin/model/gsCfg.js"

let renderer = null
let activeUser = null
let activeEvent = null

const emptyUser = {
  qq: undefined,
  uid: "",
  ckUids: [],
  getCkUidList: () => [],
  getUidList: () => [],
  getUid: () => "",
  getMysUser: () => undefined,
  hasCk: false,
}

export function configureRuntime(options = {}) {
  if (options.renderer) renderer = options.renderer
}

export function setActiveUser(user, e) {
  if (user) activeUser = user
  if (e) activeEvent = e
}

export function getActiveUser() {
  return activeUser
}

export function getActiveEvent() {
  return activeEvent
}

function resolveEvent(e) {
  return e || activeEvent || undefined
}

function currentUser() {
  return activeUser || activeEvent?.user || emptyUser
}

/**
 * 渲染 miao-plugin 的模板。
 *
 * @param {string} plugin 固定 'miao-plugin'
 * @param {string} tpl 相对 resources 的模板路径
 * @param {object} params 模板数据
 * @param {object} options { e, scale, retType, beforeRender }
 * @returns {Promise<Buffer|string>}
 */
export async function render(plugin = "miao-plugin", tpl, params = {}, options = {}) {
  if (!renderer) {
    throw new Error("当前宿主未提供图片渲染能力，无法生成图片面板")
  }

  const name = String(tpl || "")
    .replace(/\.html$/i, "")
    .replace(/^[/\\]+/, "")
  if (!name) throw new Error("模板路径为空")

  const tplFile = path.join(miaoRoot, "resources", `${name}.html`)
  if (!fs.existsSync(tplFile)) {
    throw new Error(`模板不存在：${tplFile}`)
  }

  const resourcesUrl = `${pathToFileURL(path.join(miaoRoot, "resources")).href}/`
  let data = params && typeof params === "object" ? { ...params } : {}
  if (data.pluResPath === undefined) data.pluResPath = resourcesUrl

  if (typeof options.beforeRender === "function") {
    const extra = await options.beforeRender({ data })
    if (extra && typeof extra === "object") data = { ...data, ...extra }
  }
  if (data.pluResPath === undefined) data.pluResPath = resourcesUrl

  // miao 的 beforeRender 返回 Windows 路径 / 正斜杠混合，
  // 统一成正斜杠，art-template 的 path.resolve 在 Windows 下可以正确识别盘符。
  for (const key of ["defaultLayout", "elemLayout", "_layout_path", "_tpl_path"]) {
    if (typeof data[key] === "string") data[key] = data[key].replace(/\\/g, "/")
  }

  const scale = options.scale
  if (scale && (!data.sys || !data.sys.scale)) {
    data.sys = { ...(data.sys || {}), scale: `style=transform:scale(${scale})` }
  }

  const renderData = {
    ...data,
    saveId: data.saveId ?? data.save_id ?? name.split("/").pop(),
    tplFile,
    pageGotoParams: data.pageGotoParams || { waitUntil: "networkidle2", timeout: 120000 },
  }

  const image = await renderer.render(`miao-plugin/${name}`, renderData)
  if (!image) throw new Error("图片渲染失败")

  if (options.retType === "base64") {
    return Buffer.isBuffer(image) ? image.toString("base64") : String(image)
  }
  return image
}

export async function getUid(e) {
  const target = resolveEvent(e)
  if (!target) return ""
  try {
    return (await MysInfo.getUid(target)) || ""
  } catch (error) {
    globalThis.logger?.error?.("[miao-yunzai] getUid 失败", error)
    return ""
  }
}

export async function getMysInfo(targetType = "all", e) {
  const target = resolveEvent(e)
  if (!target) return false
  try {
    return await MysInfo.init(target, targetType === "cookie" ? "detail" : "roleIndex")
  } catch (error) {
    globalThis.logger?.error?.("[miao-yunzai] getMysInfo 失败", error)
    return false
  }
}

export async function getMysApi(targetType = "all", option = {}, isSr = false, e) {
  const mys = await getMysInfo(targetType, e)
  if (mys && mys.uid && mys?.ckInfo?.ck) {
    if (isSr) option.game = "sr"
    return new MysApi(mys.uid, mys.ckInfo.ck, option, isSr)
  }
  return false
}

export function createMysApi(uid, ck, option = {}, isSr = false) {
  if (isSr) option.game = "sr"
  return new MysApi(uid, ck, option, isSr)
}

export function createInitApis() {
  const runtime = {
    get user() {
      return currentUser()
    },
    get NoteUser() {
      return NoteUser
    },
    get MysUser() {
      return MysUser
    },
    get MysInfo() {
      return MysInfo
    },
    get gsCfg() {
      return gsCfg
    },
    render,
    getUid,
    getMysInfo,
    getMysApi,
    createMysApi,
  }

  // 某些宿主没有 ctx.runtime，只把能力挂在 ctx.host 上时也能用。
  const host = {
    render,
    getUid,
    getMysInfo,
    getMysApi,
    createMysApi,
  }

  return { runtime, host }
}
