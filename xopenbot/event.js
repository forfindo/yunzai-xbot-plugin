/**
 * 把 openbot ctx 包装成 Yunzai 插件期望的 e 对象。
 *
 * 字段与 lib/plugins/loader.js 的 dealMsg 保持一致，并补齐
 * e.bot / e.group / e.friend 中插件实际使用到的方法。
 * 宿主不支持的能力只记录日志并返回 false，避免产生未处理的异常。
 */
import { createReply, forwardPart, toParts } from "./message.js"

function id(value) {
  if (value === undefined || value === null || value === "") return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : value
}

function buildSource(e, ctx) {
  const raw = ctx.replyTo || ctx.source || null
  if (!raw) return null
  const source = { ...raw }
  const messageId = raw.messageId ?? raw.message_id ?? raw.seq
  if (source.message_id === undefined) source.message_id = messageId ?? e.message_id
  if (source.seq === undefined) source.seq = messageId ?? e.message_id
  if (source.time === undefined) {
    const time = Number(raw.time)
    source.time = Number.isFinite(time) ? time : Date.now()
  }
  if (source.message === undefined) source.message = raw.elements ?? raw.message
  if (source.elements === undefined) source.elements = raw.elements
  if (source.user_id === undefined) source.user_id = raw.userId ?? raw.user_id
  return source
}

function buildSender(e, ctx) {
  const sender = { ...(ctx.sender || {}) }
  if (sender.user_id === undefined) sender.user_id = e.user_id
  if (sender.nickname === undefined) sender.nickname = ctx.nickname ?? sender.card
  if (sender.card === undefined) sender.card = ctx.nickname ?? sender.nickname
  return sender
}

function hasAtBot(ctx, selfId) {
  if (ctx.atBot !== undefined) return Boolean(ctx.atBot)
  if (!Array.isArray(ctx.elements)) return false
  return ctx.elements.some(item => {
    if (!item || item.type !== "at") return false
    return String(item.userId ?? item.qq ?? "") === String(selfId ?? "")
  })
}

async function getChatHistory(e, ctx, seq) {
  if (ctx.replyTo?.elements) {
    return [
      {
        ...ctx.replyTo,
        seq,
        message_id: ctx.replyTo.message_id ?? ctx.replyTo.messageId ?? seq,
        message: ctx.replyTo.elements,
        elements: ctx.replyTo.elements,
      },
    ]
  }
  if (typeof ctx.host?.getHistory === "function") {
    try {
      const message = await ctx.host.getHistory(seq ?? e.source?.seq ?? e.source?.time)
      return message ? [message] : []
    } catch (error) {
      globalThis.logger?.debug?.("[miao-yunzai] getHistory 失败", error)
    }
  }
  return []
}

function normalizeMemberMap(value) {
  if (value instanceof Map) return value
  const map = new Map()
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item) continue
      const userId = item.userId ?? item.user_id ?? item.qq
      if (userId === undefined || userId === null) continue
      map.set(id(userId), item)
    }
    return map
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      map.set(id(key), item)
    }
  }
  return map
}

function memberMapOf(e, ctx) {
  if (ctx.host?.__memberMap instanceof Map) return ctx.host.__memberMap
  return normalizeMemberMap(ctx.members ?? ctx.memberMap ?? ctx.member_map)
}

function buildGroup(e, ctx) {
  if (e.group_id === undefined) return undefined
  const host = ctx.host || {}
  const group = {
    group_id: e.group_id,
    group_name: e.group_name,
    name: e.group_name,
    is_owner: Boolean(ctx.member?.isOwner || ctx.member?.is_owner || ctx.sender?.role === "owner"),
    getChatHistory: (seq, count) => getChatHistory(e, ctx, seq, count),
    getMemberMap: async () => {
      if (typeof host.getMemberMap === "function") {
        try {
          const ret = await host.getMemberMap()
          const map = normalizeMemberMap(ret)
          host.__memberMap = map
          return map
        } catch (error) {
          globalThis.logger?.debug?.("[miao-yunzai] getMemberMap 失败", error)
        }
      }
      return memberMapOf(e, ctx)
    },
    pickMember(userId) {
      let info = null
      if (typeof host.getMember === "function") {
        try {
          const ret = host.getMember(String(userId))
          if (ret && typeof ret.then !== "function") info = ret
        } catch {
          // 宿主未实现，继续使用缓存
        }
      }
      if (!info) info = memberMapOf(e, ctx).get(id(userId)) ?? null
      return {
        user_id: id(userId),
        info,
        sendMsg: async message => {
          if (typeof host.sendPrivate === "function") {
            return await host.sendPrivate(String(userId), toParts(message))
          }
          return false
        },
      }
    },
    makeForwardMsg: async (messages, title) => forwardPart(messages, title),
    sendMsg: async message => e.reply(message),
    recallMsg: async messageId => {
      if (typeof host.recallMessage === "function") {
        return await host.recallMessage(messageId)
      }
      return false
    },
    getFileUrl: async fid => {
      if (typeof host.getFileUrl === "function") return await host.getFileUrl(fid)
      return undefined
    },
    sendFile: async () => {
      globalThis.logger?.warn?.("[miao-yunzai] 当前宿主不支持发送群文件")
      return false
    },
    quit: async () => {
      if (typeof host.quitGroup === "function") return await host.quitGroup(String(e.group_id))
      globalThis.logger?.warn?.("[miao-yunzai] 当前宿主不支持主动退群")
      return false
    },
  }
  return group
}

function buildFriend(e, ctx) {
  if (e.group_id !== undefined) return undefined
  const host = ctx.host || {}
  return {
    user_id: e.user_id,
    nickname: e.sender?.nickname,
    getChatHistory: (seq, count) => getChatHistory(e, ctx, seq, count),
    makeForwardMsg: async (messages, title) => forwardPart(messages, title),
    sendMsg: async message => e.reply(message),
    recallMsg: async messageId => {
      if (typeof host.recallMessage === "function") {
        return await host.recallMessage(messageId)
      }
      return false
    },
    sendFile: async () => {
      globalThis.logger?.warn?.("[miao-yunzai] 当前宿主不支持发送私聊文件")
      return false
    },
    getFileUrl: async fid => {
      if (typeof host.getFileUrl === "function") return await host.getFileUrl(fid)
      return undefined
    },
    getAvatarUrl: async () => {
      if (typeof ctx.member?.avatar === "string") return ctx.member.avatar
      return e.user_id === undefined
        ? undefined
        : `https://q1.qlogo.cn/g?b=qq&s=640&nk=${e.user_id}`
    },
    poke: async () => {
      if (typeof host.poke === "function") return await host.poke(e.user_id)
      globalThis.logger?.warn?.("[miao-yunzai] 当前宿主不支持戳一戳")
      return false
    },
  }
}

function parseMessage(e, input) {
  const elements = Array.isArray(e.message) ? e.message : []
  let msg = ""
  let hasText = false

  for (const val of elements) {
    if (!val || typeof val !== "object") continue
    switch (val.type) {
      case "text":
        hasText = true
        msg += String(val.text ?? "")
          .replace(/^\s*[＃井#]+\s*/, "#")
          .replace(/^\s*[\\*※＊]+\s*/, "*")
          .trim()
        break
      case "image":
        if (!e.img) e.img = []
        e.img.push(val.url ?? val.file)
        break
      case "at": {
        const userId = val.userId ?? val.qq ?? val.id
        if (String(userId) === String(e.self_id)) {
          e.atBot = true
        } else if (userId !== undefined) {
          e.at = userId
        }
        break
      }
      case "file":
        e.file = { name: val.name, fid: val.fid }
        break
      case "xml":
      case "json":
        hasText = true
        msg += typeof val.data === "string" ? val.data : JSON.stringify(val.data)
        break
    }
  }

  if (!hasText) {
    msg = String(input ?? "")
  }
  e.msg = msg
    .replace(/^\s*[＃井#]+\s*/, "#")
    .replace(/^\s*[\\*※＊]+\s*/, "*")
    .trim()
  if (!e.message.length && e.msg) {
    e.message = [{ type: "text", text: e.msg }]
    e.elements = e.message
  }
}

function buildToString(e) {
  return () =>
    (e.message || [])
      .map(item => {
        if (!item || typeof item !== "object") return ""
        switch (item.type) {
          case "text":
            return String(item.text ?? "")
          case "at":
            return `{at:${item.userId ?? item.qq ?? item.id}}`
          case "image":
            return "[图片]"
          case "face":
            return "[表情]"
          case "record":
            return "[语音]"
          case "video":
            return "[视频]"
          default:
            return ""
        }
      })
      .join("") ||
    e.msg ||
    ""
}

export function createEvent(input, ctx = {}) {
  const selfId = id(ctx.selfId)
  const userId = id(ctx.userId ?? ctx.sender?.user_id ?? ctx.member?.user_id)
  const groupId = id(ctx.groupId)
  const messageId = id(ctx.messageId)
  const isAdmin = Boolean(
    ctx.isAdmin ||
    ctx.member?.isAdmin ||
    ctx.member?.is_admin ||
    ["owner", "admin"].includes(ctx.sender?.role),
  )
  const pokeEvent = ctx.type === "poke" || ctx.noticeType === "poke" || ctx.notice_type === "poke"
  const requestEvent =
    ctx.type === "request" || Boolean(ctx.requestType) || ctx.post_type === "request"

  let postType = ctx.post_type
  if (!postType) {
    if (pokeEvent) postType = "notice"
    else if (requestEvent) postType = "request"
    else if (ctx.type === "notice" || ctx.noticeType || ctx.notice_type) postType = "notice"
    else postType = "message"
  }

  const elements = ctx.elements ?? ctx.message ?? []
  const e = {
    post_type: postType,
    message_type: groupId === undefined ? "private" : "group",
    sub_type: ctx.subType ?? ctx.sub_type ?? (pokeEvent ? "poke" : "normal"),
    notice_type: pokeEvent
      ? groupId === undefined
        ? "friend"
        : "group"
      : (ctx.noticeType ??
        ctx.notice_type ??
        (postType === "notice" ? (groupId === undefined ? "friend" : "group") : undefined)),
    request_type: ctx.requestType ?? ctx.request_type,
    detail_type: ctx.detailType ?? ctx.detail_type,
    self_id: selfId,
    user_id: userId,
    group_id: groupId,
    message_id: messageId,
    group_name: ctx.groupName ?? ctx.group_name,
    msg: input,
    raw_message: ctx.raw_message ?? input,
    original_msg: ctx.originalMessage ?? ctx.original_message ?? ctx.raw_message ?? input,
    message: Array.isArray(elements) ? elements : [],
    elements,
    at: ctx.at,
    atBot: hasAtBot(ctx, selfId),
    isPrivate: groupId === undefined,
    isMaster: Boolean(ctx.isMaster),
    isAdmin,
    isPoke:
      pokeEvent &&
      (groupId === undefined ||
        ctx.isPoke === true ||
        ctx.targetId === undefined ||
        ctx.targetId === null ||
        String(ctx.targetId) === String(selfId)),
    target_id: id(ctx.targetId),
    operator_id: id(ctx.operatorId),
    uid: ctx.uid ?? "",
    game: ctx.game ?? "gs",
    nickname: ctx.nickname,
    sender: undefined,
    member: undefined,
    runtime: undefined,
    group: undefined,
    friend: undefined,
    bot: undefined,
    source: null,
    hasReply: false,
    hasAlias: false,
    _isReplyed: false,
    _replyNeedUid: undefined,
    noTips: false,
    __ctx: ctx,
  }

  parseMessage(e, input)
  e.sender = buildSender(e, ctx)
  if (!e.nickname) e.nickname = e.sender.nickname
  e.member = {
    ...(ctx.member || {}),
    user_id: userId,
    nickname: e.sender.nickname,
    card: e.sender.card,
    is_admin: isAdmin,
    is_owner: Boolean(ctx.member?.isOwner || ctx.member?.is_owner || ctx.sender?.role === "owner"),
    getAvatarUrl: async () => {
      if (typeof ctx.member?.avatar === "string") return ctx.member.avatar
      return userId === undefined ? undefined : `https://q1.qlogo.cn/g?b=qq&s=640&nk=${userId}`
    },
    getChatHistory: seq => getChatHistory(e, ctx, seq),
  }
  e.source = buildSource(e, ctx)
  e.group = buildGroup(e, ctx)
  e.friend = buildFriend(e, ctx)

  const memberMap = memberMapOf(e, ctx)
  e.bot = {
    uin: selfId,
    fl: globalThis.Bot?.fl instanceof Map ? globalThis.Bot.fl : new Map(),
    gml: new Map(groupId === undefined ? [] : [[groupId, memberMap]]),
    logger: globalThis.logger,
    stat: {},
    getForwardMsg: async resId => {
      if (typeof ctx.host?.getForward === "function") {
        try {
          return await ctx.host.getForward(resId)
        } catch (error) {
          globalThis.logger?.debug?.("[miao-yunzai] getForward 失败", error)
        }
      }
      return null
    },
    sendPrivateMsg: async (qq, message) => {
      if (typeof ctx.host?.sendPrivate === "function") {
        return await ctx.host.sendPrivate(String(qq), toParts(message))
      }
      if (groupId === undefined && String(qq) === String(userId)) {
        return await e.reply(message)
      }
      globalThis.logger?.warn?.("[miao-yunzai] 当前宿主不支持主动私聊")
      return false
    },
    pickUser: qq => ({
      user_id: qq,
      sendMsg: message => e.bot.sendPrivateMsg(qq, message),
      getAvatarUrl: async () => `https://q1.qlogo.cn/g?b=qq&s=640&nk=${qq}`,
    }),
    pickGroup: group => ({
      group_id: group,
      sendMsg: async message => {
        if (typeof ctx.host?.sendGroup === "function") {
          return await ctx.host.sendGroup(String(group), toParts(message))
        }
        if (String(group) === String(groupId)) return await e.reply(message)
        globalThis.logger?.warn?.("[miao-yunzai] 当前宿主不支持主动群发")
        return false
      },
    }),
  }

  e.getReply = async replyId => {
    const quoted = ctx.replyTo?.elements ?? ctx.replyTo?.message
    if (replyId === undefined && Array.isArray(quoted)) {
      return {
        ...ctx.replyTo,
        message_id: ctx.replyTo.message_id ?? ctx.replyTo.messageId,
        message: quoted,
        elements: quoted,
      }
    }
    const target = replyId ?? e.source?.seq ?? e.source?.time
    if (target === undefined || target === null) return null
    if (typeof ctx.host?.getHistory === "function") {
      try {
        return await ctx.host.getHistory(target)
      } catch {
        return null
      }
    }
    return null
  }

  e.approve = async (approve = true, remark = "") => {
    if (typeof ctx.host?.approve === "function") {
      return await ctx.host.approve(approve, remark)
    }
    globalThis.logger?.warn?.("[miao-yunzai] 当前宿主不支持处理请求事件")
    return false
  }

  e.toString = buildToString(e)
  Object.defineProperty(e, "isSr", {
    configurable: true,
    get: () => e.game === "sr",
    set: value => {
      e.game = value ? "sr" : "gs"
    },
  })
  Object.defineProperty(e, "isGs", {
    configurable: true,
    get: () => e.game === "gs",
    set: value => {
      e.game = value ? "gs" : "sr"
    },
  })

  e.user = ctx.user ?? { qq: userId }
  createReply(e, ctx)

  return e
}
