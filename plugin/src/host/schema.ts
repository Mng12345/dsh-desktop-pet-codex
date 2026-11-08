/**
 * The Host-facing `Config` schema for this plugin's row.
 *
 * Operational only: ports, tokens, whether to launch the window. Appearance is
 * owned by the settings window and stored separately, so every setting has
 * exactly one owner and no value can silently disagree with itself.
 *
 * The shapes used here are the ones the shipped plugins already use, since this
 * schema is what the Plugin Manager renders a form from.
 *
 * `@deepseek-ai/schemastery` ships with the dsh installation. A profile bundle
 * receives such a package only when its own manifest lists it as a peer
 * dependency — that is the lookup the runtime resolver performs for a linked
 * bundle, and it is why the market's own plugins declare it too — so this
 * bundle declares the peer and imports nothing else.
 *
 * The import is dynamic and guarded for one reason: a resolution miss must
 * degrade to "no configuration form" rather than to an entry that cannot be
 * imported at all. A failed import is reported as a bare `failed to import`
 * with no detail, which is the single hardest failure to diagnose from the
 * outside; losing a form is a visible, harmless alternative.
 *
 * @module host/schema
 */

/** Build the schema, or `undefined` when the library is unavailable. */
const loadSchema = async (): Promise<unknown> => {
  try {
    const { default: z } = await import('@deepseek-ai/schemastery')
    return z.object({
      enabled: z.boolean().default(true).description('开启或关闭桌宠插件。'),

      port: z.number().min(1).max(65535).default(47600).description('本地桥接端口。'),
      portAttempts: z
        .number()
        .min(1)
        .max(200)
        .default(20)
        .description('端口被占用时向后尝试的次数。'),
      requireToken: z.boolean().default(true).description('桥接是否要求每次运行生成的令牌。'),

      autoLaunch: z.boolean().default(true).description('随 Harness 一起启动桌宠窗口。'),
      petExecutable: z.string().default('').description('自定义可执行文件路径；留空使用内置的。'),
      petArgs: z.array(z.string()).default([]).description('追加给桌宠窗口的命令行参数。'),

      sleepAfterMs: z
        .number()
        .min(0)
        .max(86400000)
        .step(1000)
        .default(300000)
        .description('安静多久之后宠物进入休眠（毫秒）。'),
      resyncMs: z
        .number()
        .min(0)
        .max(3600000)
        .step(1000)
        .default(60000)
        .description('花名册重新对齐的间隔；0 表示关闭。'),
    })
  } catch {
    return undefined
  }
}

/**
 * Validated at activation; rendered as the row's configuration form.
 *
 * Appearance is deliberately absent from it — right-click the pet and choose
 * 设置. See `core/settings.ts` for why the two surfaces are kept apart.
 */
export const Config = await loadSchema()
