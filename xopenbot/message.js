/**
 * Yunzai 消息 -> openbot Part 的转换，以及 e.reply 的落地实现。
 *
 * 宿主提供 ctx.host.send 时直接发送；否则把 Part 收集起来放在 e.__parts，
 * 由 dispatch 返回给 Workspace。
 */

function imageContent(value) {
  if (typeof value !== "string") return ""
  if (value.startsWith("base64://")) return value.slice("base64://".length)
  const data = /^data:[^;]+;base64,(.*)$/s.exec(value)
  if (data) return data[1]
  return ""
}

function imageFromFile(file) {
  if (file === null || file === undefined) return null
  if (Buffer.isBuffer(file)) {
    return { type: "image", content: file.toString("base64") }
  }
  if (typeof file === "string") {
    const content = imageContent(file)
    if (content) return { type: "image", content }
    return { type: "image", path: file }
  }
  if (typeof file === "object") return imageFromObject(file)
  return null
}

function imageFromObject(value) {
  if (!value || typeof value !== "object") return null
  if (value.content) {
    const raw = String(value.content)
    return { type: "image", content: imageContent(raw) || raw }
  }
  const file = value.file ?? value.path
  if (file) {
    const part = imageFromFile(file)
    if (part) return part
  }
  if (value.url) return { type: "image", path: String(value.url) }
  return null
}

function forwardNode(message, title) {
  if (message === null || message === undefined) return []
  if (Array.isArray(message)) return [{ title, elements: toParts(message) }]
  if (typeof message === "string" || typeof message === "number") {
    return [{ title, elements: toParts(message) }]
  }
  if (message.type === "node" && Array.isArray(message.data)) {
    return message.data.flatMap(item => forwardNode(item, title))
  }
  if (message.type === "forward" && Array.isArray(message.nodes)) return message.nodes
  if (Array.isArray(message.message) || Array.isArray(message.elements)) {
    return [
      {
        title: message.title ?? title,
        userId: message.user_id ?? message.userId,
        nickname: message.nickname,
        elements: toParts(message.message ?? message.elements),
      },
    ]
  }
  return [{ title, elements: toParts(message) }]
}

/** 对应 Yunzai 的 Bot.makeForwardMsg / e.group.makeForwardMsg */
export function forwardPart(messages, title) {
  const list = Array.isArray(messages) ? messages : [messages]
  const nodes = list
    .flatMap(message => forwardNode(message, title))
    .filter(node => node.elements.length > 0)
  return { type: "forward", title, nodes }
}

/** @returns {Array<object>} openbot Part */
export function toParts(value) {
  if (value === null || value === undefined || value === false) return []
  if (Array.isArray(value)) return value.flatMap(item => toParts(item))
  if (typeof value === "string") {
    return value.length ? [{ type: "text", text: value }] : []
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return [{ type: "text", text: String(value) }]
  }
  if (Buffer.isBuffer(value)) {
    return [{ type: "image", content: value.toString("base64") }]
  }
  if (typeof value !== "object") return []

  switch (value.type) {
    case "text":
      return value.text === undefined || value.text === null
        ? []
        : [{ type: "text", text: String(value.text) }]
    case "image": {
      const part = imageFromObject(value) || imageFromFile(value.file)
      return part ? [part] : []
    }
    case "at": {
      const userId = value.userId ?? value.qq ?? value.id
      if (userId === undefined || userId === null || userId === "") return []
      return [{ type: "at", userId, name: value.name ?? value.card }]
    }
    case "button":
      return [{ type: "button", rows: value.rows || [] }]
    case "forward":
      return [Array.isArray(value.nodes) ? value : forwardPart(value.messages, value.title)]
    case "node":
      return Array.isArray(value.data) ? [forwardPart(value.data, value.title)] : []
    case "record":
    case "video":
    case "file":
    case "json":
    case "xml":
    case "markdown":
      return []
    default:
      if (value.file) {
        const part = imageFromFile(value.file)
        if (part) return [part]
      }
      if (value.text) return [{ type: "text", text: String(value.text) }]
      return []
  }
}

/**
 * 安装 e.reply / e.flush。
 * 多次 reply 串行执行，发送失败时把错误留到 flush 统一处理。
 */
export function createReply(e, ctx) {
  e.__parts = []
  e.__sent = false
  e.__failed = null
  e.__queue = Promise.resolve()

  const enqueue = task => {
    const run = e.__queue.then(async () => {
      if (e.__failed) throw e.__failed
      return await task()
    })
    e.__queue = run.then(
      () => {},
      error => {
        if (!e.__failed) e.__failed = error
      },
    )
    return run
  }

  e.reply = (message, quote, data = {}) => {
    let parts = toParts(message)
    if (!parts.length) return false

    // 与 Yunzai loader 的 data.at 行为保持一致
    if (data?.at && e.isGroup) {
      const userId = data.at === true ? e.user_id : data.at
      if (userId !== undefined && userId !== null && userId !== "") {
        parts = [
          { type: "at", userId, name: e.sender?.card },
          { type: "text", text: "\n" },
          ...parts,
        ]
      }
    }

    return enqueue(async () => {
      const host = ctx?.host
      let result = true
      if (host && typeof host.send === "function") {
        const sent = await host.send(parts)
        e.__sent = true
        if (sent && typeof sent === "object") {
          result = sent
        } else if (sent !== undefined && sent !== null) {
          result = { message_id: sent }
        }
      } else {
        e.__parts.push(...parts)
      }
      e.__isReplyed = true
      e.hasReply = true
      e._isReplyed = true

      if (data?.recallMsg > 0) {
        const messageId = result?.message_id ?? result?.data?.message_id
        if (messageId && typeof host?.recallMessage === "function") {
          setTimeout(
            () => {
              Promise.resolve(host.recallMessage(messageId)).catch(() => {})
            },
            Number(data.recallMsg) * 1000,
          )
        }
      }
      return result
    }).then(
      result => result,
      () => false,
    )
  }

  e.flush = async () => {
    await e.__queue
    if (e.__failed) {
      const error = e.__failed
      e.__failed = null
      throw error
    }
  }

  return e.reply
}

export function collectedParts(e) {
  return e?.__parts || []
}
