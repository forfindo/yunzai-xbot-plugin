/**
 * 按 Yunzai v3 loader 的语义分发消息：
 * - checkLimit / 黑白名单 / onlyReplyAt / sr、zzz 前缀
 * - Runtime.init(e) 注入 e.runtime / e.user
 * - 每次事件重新实例化插件，检查 disable / event
 * - 先处理 getContext 上下文，再处理 accept，最后按 priority 执行 rule
 *
 * 未命中任何 Yunzai 命令时返回 { next: true }，让 Workspace 继续执行
 * 后续插件（例如 miao-plugin）。
 */
import cfg from "../lib/config/config.js"
import Runtime from "../lib/plugins/runtime.js"
import { createEvent } from "./event.js"
import { setActiveContext } from "./globals.js"
import { collectedParts } from "./message.js"
import { prepareHost } from "./host.js"
import { setActiveUser } from "./runtime.js"
import store from "./store.js"

const srReg = /^#?(\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+/
const zzzReg = /^#?(%|％|绝区零|绝区)+/

const eventMap = {
  message: ["post_type", "message_type", "sub_type"],
  notice: ["post_type", "notice_type", "sub_type"],
  request: ["post_type", "request_type", "sub_type"],
}

const msgThrottle = {}
const groupGlobalCD = {}
const singleCD = {}

function log() {
  return globalThis.logger || console
}

function isEmpty(value) {
  return !value || Object.keys(value).length === 0
}

function truncate(value, length = 100) {
  const text = String(value ?? "")
  return text.length > length ? `${text.slice(0, length)}...` : text
}

function numericId(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : String(value)
}

function isMasterQQ(userId) {
  const ids = cfg.masterQQ || []
  const id = numericId(userId)
  return ids.some(item => String(item) === String(id))
}

function filtEvent(e, v) {
  if (!v.event) return false
  const event = String(v.event).split(".")
  const map = eventMap[e.post_type] || []
  const current = event.map((part, index) => (part === "*" ? "*" : e[map[index]]))
  return v.event === current.join(".")
}

function filtPermission(e, v) {
  if (v.permission === "all" || !v.permission) return true

  if (v.permission === "master") {
    if (e.isMaster) return true
    e.reply("暂无权限，只有主人才能操作")
    return false
  }

  if (e.isGroup) {
    if (v.permission === "owner" && !e.member?.is_owner) {
      e.reply("暂无权限，只有群主才能操作")
      return false
    }
    if (v.permission === "admin" && !e.member?.is_admin) {
      e.reply("暂无权限，只有管理员才能操作")
      return false
    }
  }

  return true
}

function checkBlack(e) {
  const other = cfg.getOther()
  const userId = numericId(e.user_id)

  if (other.blackQQ?.length) {
    if (other.blackQQ.some(qq => String(qq) === String(userId))) return false
    if (e.at !== undefined && other.blackQQ.some(qq => String(qq) === String(e.at))) return false
  }
  if (other.whiteQQ?.length) {
    if (!other.whiteQQ.some(qq => String(qq) === String(userId))) return false
  }

  if (e.group_id !== undefined) {
    if (
      other.blackGroup?.length &&
      other.blackGroup.some(group => String(group) === String(e.group_id))
    )
      return false
    if (
      other.whiteGroup?.length &&
      !other.whiteGroup.some(group => String(group) === String(e.group_id))
    )
      return false
  }

  return true
}

function checkLimit(e) {
  if (!e.message?.length || e.isPrivate) return true

  const config = cfg.getGroup(e.group_id)
  if (config.groupGlobalCD && groupGlobalCD[e.group_id]) return false
  if (config.singleCD && singleCD[`${e.group_id}.${e.user_id}`]) return false

  const msgId = `${e.user_id}:${e.raw_message}`
  if (msgThrottle[msgId]) return false
  msgThrottle[msgId] = true
  setTimeout(() => {
    delete msgThrottle[msgId]
  }, 200)
  return true
}

function setLimit(e) {
  if (!e.message?.length || e.isPrivate) return
  const config = cfg.getGroup(e.group_id)

  if (config.groupGlobalCD) {
    groupGlobalCD[e.group_id] = true
    setTimeout(() => {
      delete groupGlobalCD[e.group_id]
    }, config.groupGlobalCD)
  }
  if (config.singleCD) {
    const key = `${e.group_id}.${e.user_id}`
    singleCD[key] = true
    setTimeout(() => {
      delete singleCD[key]
    }, config.singleCD)
  }
}

function onlyReplyAt(e) {
  if (!e.message?.length || e.isPrivate) return true

  const groupCfg = cfg.getGroup(e.group_id)
  if (groupCfg.onlyReplyAt == 0 || !groupCfg.botAlias) return true
  if (groupCfg.onlyReplyAt == 2 && e.isMaster) return true
  if (e.atBot) return true
  if (e.hasAlias) return true
  return false
}

function checkDisable(plugin) {
  const groupCfg = cfg.getGroup(plugin.e.group_id)
  if (groupCfg.disable?.length && groupCfg.disable.includes(plugin.name)) return false
  if (groupCfg.enable?.length && !groupCfg.enable.includes(plugin.name)) return false
  return true
}

function finalizeMsg(e) {
  if (e.user_id !== undefined && isMasterQQ(e.user_id)) e.isMaster = true

  if (e.isPrivate) {
    if (e.sender) e.sender.card = e.sender.nickname
    e.logText = `[私聊][${e.sender?.nickname ?? e.sender?.card}(${e.user_id})]`
  }

  if (e.isGroup) {
    if (e.sender) e.sender.card = e.sender.card || e.sender.nickname
    if (!e.group_name) e.group_name = e.group?.group_name
    e.logText = `[${e.group_name ?? e.group_id}(${e.sender?.card ?? e.user_id})]`
  }

  if (e.msg && e.isGroup) {
    let alias = cfg.getGroup(e.group_id).botAlias
    if (!Array.isArray(alias)) alias = [alias]
    for (const name of alias) {
      if (!name) continue
      if (e.msg.startsWith(name)) {
        e.msg = e.msg.slice(String(name).length).trim()
        e.hasAlias = true
        break
      }
    }
  }
}

function applyGamePrefix(e) {
  if (!e.msg) return
  if (srReg.test(e.msg)) {
    e.game = "sr"
    e.msg = e.msg.replace(srReg, "#星铁")
  } else if (zzzReg.test(e.msg)) {
    e.game = "zzz"
    e.msg = e.msg.replace(zzzReg, "#绝区零")
  }
}

async function runContext(plugins, e) {
  for (const plugin of plugins) {
    if (typeof plugin.getContext !== "function") continue
    const context = {
      ...plugin.getContext(),
      ...plugin.getContext(false, true),
    }
    if (process.env.XOPENBOT_DEBUG_CTX && !isEmpty(context)) {
      log().info?.(`[miao-yunzai] context ${plugin.name}`, Object.keys(context))
    }
    if (isEmpty(context)) continue

    let ret
    for (const fnc in context) {
      if (typeof plugin[fnc] !== "function") continue
      ret ||= await plugin[fnc](context[fnc])
    }
    if (ret === "continue") continue
    return { handled: true }
  }
  return { handled: false }
}

async function runAccept(plugins, e) {
  for (const plugin of plugins) {
    if (typeof plugin.accept !== "function") continue
    const ret = await plugin.accept(e)
    if (ret === "return") return { handled: true, stop: true }
    if (ret) break
  }
  return { handled: false }
}

async function runRules(plugins, e) {
  let handled = false

  outer: for (const plugin of plugins) {
    if (!plugin.rule) continue
    for (const rule of plugin.rule) {
      if (rule.event && !filtEvent(e, rule)) continue
      let matched = false
      try {
        matched = new RegExp(rule.reg).test(e.msg)
      } catch (error) {
        log().error?.(`[miao-yunzai] 无效的正则：${rule.reg}`, error)
        continue
      }
      if (!matched) continue

      e.logFnc = `[${plugin.name}][${rule.fnc}]`
      if (rule.log !== false) {
        log().info?.(`${e.logFnc}${e.logText ?? ""} ${truncate(e.msg)}`)
      }

      if (!filtPermission(e, rule)) {
        handled = true
        break outer
      }

      try {
        const start = Date.now()
        const result =
          typeof plugin[rule.fnc] === "function" ? await plugin[rule.fnc](e) : undefined
        if (result !== false) {
          handled = true
          setLimit(e)
          if (rule.log !== false) {
            log().mark?.(`${e.logFnc} ${truncate(e.msg)} 处理完成 ${Date.now() - start}ms`)
          }
          break outer
        }
      } catch (error) {
        handled = true
        log().error?.(`${e.logFnc}`)
        log().error?.(error?.stack || error)
        break outer
      }
    }
  }

  return { handled }
}

async function createPlugins(priority, e) {
  const plugins = []
  for (const item of priority) {
    try {
      const instance = new item.class(e)
      instance.e = e
      if (checkDisable(instance) && filtEvent(e, instance)) plugins.push(instance)
    } catch (error) {
      log().error?.(`[miao-yunzai] 实例化插件失败：${item.name}`, error)
    }
  }
  return plugins
}

/**
 * @param {Array} priority loader.loadPlugins() 的结果
 * @returns {(input: string, ctx?: object) => Promise<object>}
 */
export function createDispatch(priority) {
  return async function dispatch(input, ctx = {}) {
    setActiveContext(ctx)
    await prepareHost(ctx)

    const e = createEvent(input, ctx)
    finalizeMsg(e)

    let handled = false
    let stop = false

    try {
      // 冷却 / 黑白名单：命中后终止整条消息（与 Yunzai 行为一致）
      if (!checkLimit(e) || !checkBlack(e)) {
        stop = true
      }

      if (!stop) {
        try {
          await Runtime.init(e)
        } catch (error) {
          log().error?.("[miao-yunzai] Runtime.init 失败", error)
        }
        setActiveUser(e.user, e)

        const plugins = await createPlugins(priority, e)
        const context = await runContext(plugins, e)

        if (context.handled) {
          handled = true
          stop = true
        } else if (!onlyReplyAt(e)) {
          stop = true
        } else {
          applyGamePrefix(e)

          const accept = await runAccept(plugins, e)
          if (accept.handled) handled = true
          if (accept.stop) {
            stop = true
          } else {
            const rules = await runRules(plugins, e)
            handled = handled || rules.handled
          }
        }
      }
    } catch (error) {
      handled = true
      log().error?.("[miao-yunzai] 命令执行失败", error)
      try {
        if (!e.__isReplyed) await e.reply("处理命令时遇到错误，请稍后再试")
      } catch {
        // 宿主发送也失败时只能放弃
      }
    } finally {
      try {
        await e.flush()
      } catch (error) {
        log().error?.("[miao-yunzai] 消息发送失败", error)
      }
      await store.flush()
    }

    const content = collectedParts(e)
    if (content.length) return { content }
    if (stop) return {}
    return handled ? {} : { next: true }
  }
}
