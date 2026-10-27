/**
 * 补齐每条消息 ctx.host 上缺失的能力。
 *
 * Workspace 用浅合并构造每个命令的 ctx，ctx.host 是同一个对象引用，
 * 因此这里对 host 的修改对后续 miao-plugin 的命令同样可见。
 * 已由宿主实现的方法会保留，只在调用失败时降级。
 */
import { render, getUid, getMysInfo, getMysApi, createMysApi } from "./runtime.js"

const PATCHED = Symbol.for("xopenbot.host.patched")

function memberKey(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : value
}

function normalizeMemberMap(value) {
  if (value instanceof Map) return value
  const map = new Map()
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item) continue
      const userId = item.userId ?? item.user_id ?? item.qq
      if (userId === undefined || userId === null) continue
      map.set(memberKey(userId), item)
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) map.set(memberKey(key), item)
  }
  return map
}

function wrapAsync(host, name, fallback) {
  const original = typeof host[name] === "function" ? host[name].bind(host) : null
  host[name] = async (...args) => {
    if (original) {
      try {
        const ret = await original(...args)
        if (ret !== undefined) return ret
      } catch (error) {
        globalThis.logger?.debug?.(`[miao-yunzai] host.${name} 不可用`, error)
      }
    }
    return typeof fallback === "function" ? fallback(...args) : fallback
  }
}

export async function prepareHost(ctx) {
  if (!ctx || typeof ctx !== "object") return null
  if (!ctx.host || typeof ctx.host !== "object") ctx.host = {}
  const host = ctx.host
  if (host[PATCHED]) return host
  Object.defineProperty(host, PATCHED, { value: true, enumerable: false })

  wrapAsync(host, "getHistory", () => null)
  wrapAsync(host, "getForward", () => null)

  const originalGetMemberMap =
    typeof host.getMemberMap === "function" ? host.getMemberMap.bind(host) : null
  host.getMemberMap = async () => {
    if (host.__memberMap instanceof Map) return host.__memberMap
    if (originalGetMemberMap) {
      try {
        const ret = await originalGetMemberMap()
        host.__memberMap = normalizeMemberMap(ret)
        return host.__memberMap
      } catch (error) {
        globalThis.logger?.debug?.("[miao-yunzai] host.getMemberMap 不可用", error)
      }
    }
    host.__memberMap = normalizeMemberMap(ctx.members ?? ctx.memberMap ?? ctx.member_map)
    return host.__memberMap
  }

  const originalGetMember = typeof host.getMember === "function" ? host.getMember.bind(host) : null
  host.getMember = userId => {
    if (originalGetMember) {
      try {
        const ret = originalGetMember(userId)
        // HOST.md 约定 getMember 是同步的；返回 Promise 时走缓存
        if (ret && typeof ret.then !== "function") return ret
      } catch (error) {
        globalThis.logger?.debug?.("[miao-yunzai] host.getMember 不可用", error)
      }
    }
    return host.__memberMap?.get(memberKey(userId)) ?? null
  }

  if (typeof host.render !== "function") host.render = render
  if (typeof host.getUid !== "function") host.getUid = getUid
  if (typeof host.getMysInfo !== "function") host.getMysInfo = getMysInfo
  if (typeof host.getMysApi !== "function") host.getMysApi = getMysApi
  if (typeof host.createMysApi !== "function") host.createMysApi = createMysApi

  // 群成员列表是同步 API（e.bot.gml / e.group.pickMember）的数据来源，
  // 在命令执行前尽量预热一次。失败不影响消息处理。
  if (ctx.groupId && typeof host.getMemberMap === "function") {
    try {
      host.__memberMap = normalizeMemberMap(await host.getMemberMap())
    } catch (error) {
      globalThis.logger?.debug?.("[miao-yunzai] 预热群成员列表失败", error)
      host.__memberMap = new Map()
    }
  }

  return host
}
