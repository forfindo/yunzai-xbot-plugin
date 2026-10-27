/**
 * 本地 JSON 存储，提供 Yunzai 使用到的 redis 接口子集。
 * 宿主 ctx.host.redis 存在时会切换到宿主实现（见 globals.setActiveContext）。
 *
 * 默认文件：<projectRoot>/data/miao-plugin/store.json。
 * 与 miao-plugin 独立运行时的默认数据目录一致，两个插件可以共享绑定数据。
 */
import fs from "node:fs"
import path from "node:path"
import { storeFile } from "./paths.js"

const dataRoot = path.dirname(storeFile)
const tempFile = `${storeFile}.tmp`

const state = {
  kv: {},
  hash: {},
  zset: {},
  expires: {},
}

try {
  if (fs.existsSync(storeFile)) {
    const raw = JSON.parse(fs.readFileSync(storeFile, "utf8"))
    state.kv = raw.kv || {}
    state.hash = raw.hash || {}
    state.zset = raw.zset || {}
    state.expires = raw.expires || {}
  }
} catch (error) {
  console.error("[miao-yunzai] 读取本地存储失败，使用空数据", error)
}

let timer = null
let dirty = false
let saving = false

function persist() {
  if (saving || !dirty) return
  saving = true
  try {
    fs.mkdirSync(dataRoot, { recursive: true })
    fs.writeFileSync(tempFile, JSON.stringify(state), "utf8")
    fs.rmSync(storeFile, { force: true })
    fs.renameSync(tempFile, storeFile)
    dirty = false
  } catch (error) {
    console.error("[miao-yunzai] 写入本地存储失败", error)
  } finally {
    saving = false
  }
}

function schedule() {
  dirty = true
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    persist()
  }, 30)
  timer.unref?.()
}

function expireIfNeeded(key) {
  const at = state.expires[key]
  if (!at || Date.now() < at) return false
  delete state.expires[key]
  delete state.kv[key]
  delete state.hash[key]
  delete state.zset[key]
  schedule()
  return true
}

function keyMatch(key, pattern) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${source}$`).test(key)
}

function sorted(key) {
  const map = state.zset[key] || {}
  return Object.keys(map)
    .map(value => ({ value, score: Number(map[value]) || 0 }))
    .sort((a, b) => a.score - b.score || String(a.value).localeCompare(String(b.value)))
}

function slice(list, start, stop) {
  const len = list.length
  let from = Number(start)
  let to = Number(stop)
  if (Number.isNaN(from)) from = 0
  if (Number.isNaN(to)) to = -1
  if (from < 0) from = Math.max(len + from, 0)
  if (to < 0) to = len + to
  if (from > to || from >= len) return []
  return list.slice(from, to + 1)
}

function valueOf(value) {
  return String(value?.value ?? value?.member ?? value ?? "")
}

function asString(value) {
  return value === undefined || value === null ? "" : String(value)
}

const store = {
  async get(key) {
    if (expireIfNeeded(key)) return null
    return Object.prototype.hasOwnProperty.call(state.kv, key) ? state.kv[key] : null
  },

  async set(key, value, options = {}) {
    state.kv[key] = asString(value)
    if (options?.EX) {
      state.expires[key] = Date.now() + Number(options.EX) * 1000
    } else {
      delete state.expires[key]
    }
    schedule()
    return "OK"
  },

  async setEx(key, seconds, value) {
    return await store.set(key, value, { EX: seconds })
  },

  async del(...keys) {
    let count = 0
    for (const key of keys.flat()) {
      for (const map of [state.kv, state.hash, state.zset]) {
        if (Object.prototype.hasOwnProperty.call(map, key)) count++
      }
      delete state.kv[key]
      delete state.hash[key]
      delete state.zset[key]
      delete state.expires[key]
    }
    schedule()
    return count
  },

  async keys(pattern = "*") {
    const all = new Set([
      ...Object.keys(state.kv),
      ...Object.keys(state.hash),
      ...Object.keys(state.zset),
    ])
    const ret = []
    for (const key of all) {
      if (expireIfNeeded(key)) continue
      if (keyMatch(key, pattern)) ret.push(key)
    }
    return ret
  },

  async expire(key, seconds) {
    const exists = [state.kv, state.hash, state.zset].some(map =>
      Object.prototype.hasOwnProperty.call(map, key),
    )
    if (!exists) return 0
    state.expires[key] = Date.now() + Number(seconds) * 1000
    schedule()
    return 1
  },

  async incr(key) {
    const value = Number(await store.get(key)) || 0
    return await store.set(key, String(value + 1)).then(() => value + 1)
  },

  async hSet(key, field, value) {
    expireIfNeeded(key)
    if (!state.hash[key]) state.hash[key] = {}
    state.hash[key][asString(field)] = asString(value)
    schedule()
    return 1
  },

  async hGet(key, field) {
    if (expireIfNeeded(key)) return null
    const hash = state.hash[key] || {}
    field = asString(field)
    return Object.prototype.hasOwnProperty.call(hash, field) ? hash[field] : null
  },

  async hGetAll(key) {
    if (expireIfNeeded(key)) return {}
    return { ...(state.hash[key] || {}) }
  },

  async hDel(key, ...fields) {
    const hash = state.hash[key] || {}
    let count = 0
    for (const field of fields.flat()) {
      const name = asString(field)
      if (Object.prototype.hasOwnProperty.call(hash, name)) {
        delete hash[name]
        count++
      }
    }
    if (count) schedule()
    return count
  },

  async zAdd(key, entry) {
    if (!state.zset[key]) state.zset[key] = {}
    const list = Array.isArray(entry) ? entry : [entry]
    let count = 0
    for (const item of list) {
      const value = valueOf(item)
      if (!value) continue
      state.zset[key][value] = Number(item?.score) || 0
      count++
    }
    schedule()
    return count
  },

  async zRem(key, ...members) {
    const map = state.zset[key] || {}
    let count = 0
    for (const member of members.flat()) {
      const value = valueOf(member)
      if (Object.prototype.hasOwnProperty.call(map, value)) {
        delete map[value]
        count++
      }
    }
    if (count) schedule()
    return count
  },

  async zRange(key, start, stop) {
    if (expireIfNeeded(key)) return []
    return slice(sorted(key), start, stop).map(item => item.value)
  },

  async zRangeWithScores(key, start, stop) {
    if (expireIfNeeded(key)) return []
    return slice(sorted(key), start, stop)
  },

  async zScore(key, member) {
    if (expireIfNeeded(key)) return null
    const map = state.zset[key] || {}
    const value = valueOf(member)
    return Object.prototype.hasOwnProperty.call(map, value) ? map[value] : null
  },

  async zCount(key, min, max) {
    if (expireIfNeeded(key)) return 0
    min = Number(min)
    max = Number(max)
    return sorted(key).filter(item => item.score >= min && item.score <= max).length
  },

  async zRangeByScore(key, min, max) {
    const list = await store.zRangeByScoreWithScores(key, min, max)
    return list.map(item => item.value)
  },

  async zRangeByScoreWithScores(key, min, max) {
    if (expireIfNeeded(key)) return []
    min = Number(min)
    max = Number(max)
    return sorted(key).filter(item => item.score >= min && item.score <= max)
  },

  async zRemRangeByScore(key, min, max) {
    if (expireIfNeeded(key)) return 0
    const map = state.zset[key] || {}
    min = Number(min)
    max = Number(max)
    let count = 0
    for (const value of Object.keys(map)) {
      const score = Number(map[value])
      if (score >= min && score <= max) {
        delete map[value]
        count++
      }
    }
    if (count) schedule()
    return count
  },

  async zRevRank(key, member) {
    if (expireIfNeeded(key)) return null
    const list = sorted(key).reverse()
    const index = list.findIndex(item => item.value === valueOf(member))
    return index >= 0 ? index : null
  },

  async flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    persist()
  },
}

export default store
