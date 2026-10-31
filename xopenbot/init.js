import fs from 'node:fs'
import setLog from '../lib/config/log.js'
import redisInit from '../lib/config/redis.js'

/** 退出事件 */
process.on("exit", async code => {
  if (typeof redis != "undefined") await redis.save()

  if (typeof logger == "undefined") console.log("Miao-Yunzai 已停止运行")
  else logger.mark(logger.magenta("Miao-Yunzai 已停止运行"))
})

await checkInit()

/** 初始化事件 */
async function checkInit() {
  /** 检查node_modules */
  if (!fs.existsSync("./node_modules") || !fs.existsSync("./node_modules/icqq")) {
    console.log("请先运行命令：pnpm install -P 安装依赖")
    process.exit()
  }

  /** 日志设置 */
  setLog()

  logger.mark("Miao-Yunzai 启动中...")

  await redisInit()
}
