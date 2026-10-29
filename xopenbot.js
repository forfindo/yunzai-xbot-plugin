/**
 * Miao-Yunzai 的 @xopenbot/plugin 适配入口。
 *
 * 加载 plugins/** 下的全部 Yunzai 插件，并通过 init() 向同一 Workspace
 * 中的 miao-plugin 提供宿主能力（渲染、米游社账号体系等）。
 *
 * 使用方式（宿主侧）：
 *   import YunzaiPlugin from 'file:///.../yunzai-xbot-plugin/xopenbot.js'
 *   import MiaoPlugin from 'file:///.../miao-xbot-plugin/xopenbot.js'
 *   Workspace.registry([YunzaiPlugin, MiaoPlugin])
 *
 * 注意：导入本模块会把 process.cwd() 切换到 Yunzai 项目根目录，
 * 因为 Yunzai 的配置、插件、模板都使用相对路径。
 */
import { bootstrap } from "./xopenbot/bootstrap.js"

const boot = await bootstrap()

const plugin = {
  info: boot.info,
  load() {
    return [boot.command]
  },
  init() {
    return boot.apis
  },
  getScheduleTask() {
    const log = globalThis.logger || console
    return (boot.tasks || []).map(task => ({
      name: task.name,
      cron: task.cron,
      task: async () => {
        try {
          if (task.log === true) log.mark?.(`开始定时任务：${task.name}`)
          await task.fnc()
          if (task.log === true) log.mark?.(`定时任务完成：${task.name}`)
          return true
        } catch (error) {
          log.error?.(`定时任务报错：${task.name}`)
          log.error?.(error)
          return false
        }
      },
    }))
  },
}

export default plugin
export { plugin }
