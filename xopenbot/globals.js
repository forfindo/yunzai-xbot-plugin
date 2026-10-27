/**
 * Yunzai 存量代码直接使用全局变量：logger / redis / segment / Bot。
 * 这里补齐这些全局对象；宿主或其它插件已经提供时保留已有实现。
 */
import store from "./store.js"
import { forwardPart } from "./message.js"

let activeCtx = null

const fallbackLogger = {
  trace: () => {},
  info: (...args) => console.log("[miao-yunzai]", ...args),
  mark: (...args) => console.log("[miao-yunzai]", ...args),
  debug: (...args) => {
    if (process.env.MIAO_DEBUG) console.debug("[miao-yunzai]", ...args)
  },
  warn: (...args) => console.warn("[miao-yunzai]", ...args),
  error: (...args) => console.error("[miao-yunzai]", ...args),
  fatal: (...args) => console.error("[miao-yunzai]", ...args),
  green: (...args) => args.join(" "),
  red: (...args) => args.join(" "),
  yellow: (...args) => args.join(" "),
  blue: (...args) => args.join(" "),
  magenta: (...args) => args.join(" "),
  cyan: (...args) => args.join(" "),
}

function image(file) {
  if (file === null || file === undefined) return null
  if (Buffer.isBuffer(file)) {
    return { type: "image", content: file.toString("base64") }
  }
  if (typeof file === "object" && file.type === "image") return file
  if (typeof file === "object") {
    if (file.content) {
      const content = String(file.content)
      if (content.startsWith("base64://")) {
        return { type: "image", content: content.slice("base64://".length) }
      }
      const data = /^data:[^;]+;base64,(.*)$/s.exec(content)
      if (data) return { type: "image", content: data[1] }
      return { type: "image", content }
    }
    if (file.file || file.path) return image(file.file ?? file.path)
    if (file.url) return { type: "image", path: String(file.url) }
    return null
  }
  if (typeof file !== "string") return null
  if (file.startsWith("base64://")) {
    return { type: "image", content: file.slice("base64://".length) }
  }
  const data = /^data:[^;]+;base64,(.*)$/s.exec(file)
  if (data) return { type: "image", content: data[1] }
  return { type: "image", path: file }
}

function at(userId, name) {
  if (userId === undefined || userId === null || userId === "") return null
  return { type: "at", userId, name }
}

function button(...rows) {
  return { type: "button", rows }
}

const segment = {
  image,
  at,
  button,
  face: id => ({ type: "face", id }),
  record: file => ({ type: "record", file }),
  video: file => ({ type: "video", file }),
  file: (file, name) => ({ type: "file", file, name }),
  json: data => ({ type: "json", data }),
  xml: data => ({ type: "xml", data }),
  markdown: data => ({ type: "markdown", data }),
}

function partsOfActiveHost() {
  const host = activeCtx?.host
  return host && typeof host.send === "function" ? host : null
}

const bot = {
  uin: undefined,
  fl: new Map(),
  logger: fallbackLogger,
  async makeForwardMsg(messages, title) {
    return forwardPart(messages, title)
  },
  async sendPrivateMsg(userId, message) {
    const host = activeCtx?.host
    if (host && typeof host.sendPrivate === "function") {
      return await host.sendPrivate(String(userId), requireParts(message))
    }
    // 当前会话就是私聊对象时，直接回复
    if (activeCtx && !activeCtx.groupId && String(activeCtx.userId) === String(userId)) {
      return await host?.send?.(requireParts(message))
    }
    throw new Error("当前宿主不支持主动私聊")
  },
  pickUser(userId) {
    return {
      user_id: userId,
      sendMsg: message => bot.sendPrivateMsg(userId, message),
      async getAvatarUrl() {
        return undefined
      },
      poke: async () => {
        throw new Error("当前宿主不支持戳一戳")
      },
    }
  },
  pickGroup(groupId) {
    return {
      group_id: groupId,
      sendMsg: async message => {
        const host = activeCtx?.host
        if (host && typeof host.sendGroup === "function") {
          return await host.sendGroup(String(groupId), requireParts(message))
        }
        if (activeCtx && String(activeCtx.groupId) === String(groupId)) {
          return await host?.send?.(requireParts(message))
        }
        throw new Error("当前宿主不支持主动群发")
      },
    }
  },
  async restart() {
    if (typeof activeCtx?.host?.restart === "function") return await activeCtx.host.restart()
    throw new Error("当前宿主不支持重启")
  },
  async update() {
    if (typeof activeCtx?.host?.update === "function") return await activeCtx.host.update()
    throw new Error("当前宿主不支持更新")
  },
}

function requireParts(message) {
  if (
    Array.isArray(message) &&
    message.every(item => item && typeof item === "object" && item.type)
  ) {
    return message
  }
  if (Buffer.isBuffer(message)) return [image(message)]
  if (typeof message === "string" || typeof message === "number") {
    return [{ type: "text", text: String(message) }]
  }
  const part = image(message)
  return part ? [part] : []
}

function installLogger() {
  if (!globalThis.logger) {
    globalThis.logger = fallbackLogger
    return
  }
  for (const [key, fn] of Object.entries(fallbackLogger)) {
    if (typeof globalThis.logger[key] !== "function") {
      globalThis.logger[key] = fn
    }
  }
}

function installSegment() {
  if (!globalThis.segment) {
    globalThis.segment = segment
    return
  }
  for (const [key, fn] of Object.entries(segment)) {
    if (typeof globalThis.segment[key] !== "function") {
      globalThis.segment[key] = fn
    }
  }
}

function installBot() {
  if (!globalThis.Bot) {
    globalThis.Bot = bot
    return
  }
  if (!globalThis.Bot.logger) globalThis.Bot.logger = globalThis.logger || fallbackLogger
  if (!(globalThis.Bot.fl instanceof Map)) globalThis.Bot.fl = new Map()
  for (const key of [
    "makeForwardMsg",
    "sendPrivateMsg",
    "pickUser",
    "pickGroup",
    "restart",
    "update",
  ]) {
    if (typeof globalThis.Bot[key] !== "function") globalThis.Bot[key] = bot[key].bind(bot)
  }
}

export function installGlobals() {
  installLogger()
  if (!globalThis.redis) globalThis.redis = store
  installSegment()
  installBot()
  return {
    logger: globalThis.logger,
    redis: globalThis.redis,
    segment: globalThis.segment,
    Bot: globalThis.Bot,
  }
}

export function setActiveContext(ctx) {
  activeCtx = ctx || null
  if (ctx?.selfId !== undefined && globalThis.Bot) {
    const uin = Number(ctx.selfId)
    globalThis.Bot.uin = Number.isFinite(uin) ? uin : ctx.selfId
  }
  if (ctx?.host?.redis && !globalThis.__xopenbotRedisFromHost) {
    globalThis.redis = ctx.host.redis
    globalThis.__xopenbotRedisFromHost = true
  }
}

export function getActiveContext() {
  return activeCtx
}

export { store }
