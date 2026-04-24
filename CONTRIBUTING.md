# 参与贡献 (Contributing)

首先，非常感谢你抽出时间来为 `koishi-plugin-Enhanced-NekoAI` 做出贡献！

本项目最初是作为自用的高拟人 AI 聊天插件开发的，经过重构，现在已经演变成一个**全量 JSON 驱动、原生支持多模态视觉、自带抗风控 Fallback 降级机制**的现代化大型 AI 伴侣插件。

无论你是想修复 Bug、添加新功能（例如接入 GPT-SoVITS 语音、多用户私聊独立白名单等），还是仅仅改善文档，我们都张开双臂欢迎你！

以下是一份简明的指南，不仅包含了基础的 Git 提交流程，还为你梳理了本插件的核心架构与开发避坑指南，帮助你快速上手。

---

## 核心架构指南（开发者必读）

在你动手写代码之前，请务必了解本插件最新的架构逻辑，这能帮你少走很多弯路：

### 0. 模块化架构（最重要）

**本插件已从单文件架构重构为模块化架构。** 原来 1360 行的 `index.js` 已拆分为 15 个独立模块，位于 `lib/` 目录下。新的 `index.js` 仅为约 40 行的薄壳入口文件。

```
lib/
├── state.js        ← 全局状态单例（所有模块共享的变量池，含聊天节点池 / 图像节点池）
├── logger.js       ← 日志工具（带前缀和颜色的分级日志）
├── config.js       ← 配置加载、保存、默认值模板与 Koishi Schema 定义
├── utils.js        ← 通用工具函数（权限检查、群友名单、周期计算等）
├── parser.js       ← 消息内容解析（Base64 图片提取、外部链接嗅探、回复引用兼容解析）
├── sender.js       ← 消息发送（拟人分段、合并转发、Fallback 降级、表情包）
├── api.js          ← AI API 调用（文本协议适配、智能路由、xAI 图像生成编辑 / OpenAI 生图）
├── queue.js        ← 请求队列（FIFO 并发控制）
├── ratelimit.js    ← 群聊限流（12小时周期计数、阶梯预警）
├── history.js      ← 聊天历史日志持久化（按日期/时段滚动生成）
├── memory.js       ← 长期记忆持久化（自动压缩摘要、群聊/私聊独立存储）
├── memes.js        ← 表情包加载（9 个情绪分类目录）
├── commands.js     ← 所有 45+ 聊天指令注册
├── listener.js     ← 消息事件处理（三分支：@提及/私聊/话痨潜水）
└── render.js       ← 帮助菜单 / 人格列表 / 模型列表 / 状态面板 / 当前群状态 图片卡片渲染
```

**开发规则**：
* **不要在 `index.js` 中添加业务逻辑**。`index.js` 只负责调用各模块的初始化函数。
* **所有共享状态必须通过 `state.js`** 读写，不要在模块中定义全局变量。
* **新增聊天 / 图像指令请在 `commands.js`** 中添加，新增消息处理逻辑请在 `listener.js` 中添加。
* **如果模块要访问可选服务（例如 `ctx.puppeteer`）**，请在入口导出的 `inject` 中显式声明为 `optional`，避免 Koishi 输出属性注册警告。
* **避免循环依赖**：如果模块 A 和模块 B 互相需要，请在函数内部使用延迟 `require()`（不要在文件顶部 require）。例如 `commands.js` 中对 `api.js` 的引用就是在函数体内延迟 require 的。
* **群聊 @ 相关逻辑优先看 `listener.js` + `parser.js`**：`@专注回答模式`、回复引用提取、引用图片并入请求、引用来源日志都集中在这两处，不要只改提示词而忽略运行时注入链路。
* **图像能力与聊天能力已经拆分**：聊天节点使用 `api_config.json`，图像节点使用 `image_api_config.json`。后续新增图像 provider 时，优先扩展图像节点体系，不要再把图像字段塞回聊天节点。

### 1. 全量脱离 YAML 的 JSON 配置树

**请不要再往 Koishi 的 `Schema.object` (即 `koishi.yml` 里的 `Config`) 中添加任何配置项了！**

为了实现真正的热更新与防崩溃，本插件所有的运行时配置、人格设定、API 节点和调用计数，都已经彻底迁移至本地独立的 JSON 文件中：

| 文件 | 用途 | 对应模块 |
|------|------|----------|
| `runtime_config.json` | 核心参数（主人QQ、阈值、开关等） | `config.js` |
| `runtime_schema.json` | 运行时配置契约（字段 / 说明 / 约束 / 废弃信息） | GUI / `config.js` / 自检 |
| `api_config.json` | 聊天 / 文本 API 节点池 | `config.js` |
| `image_api_config.json` | 独立图像 API 节点池（xAI / OpenAI） | `config.js` / `commands.js` / `api.js` |
| `group_personality.json` | 群聊人格库 | `config.js` |
| `private_personality.json` | 私聊人格库 | `config.js` |
| `group_usage_counts.json` | 群聊独立计数的动态数据 | `ratelimit.js` |
| `commands.json` | 指令避让字典 | `utils.js` |
| `chat-history/` | 持久化的聊天日志目录 | `history.js` |
| `memory/group/*.json` | 群聊长期记忆 | `memory.js` |
| `memory/private/*.json` | 私聊长期记忆 | `memory.js` |

**开发提示**：如果你新增了一个功能需要读取参数，请同时做这三件事：

1. 修改 `state.runtimeConfig` / `defaultRuntimeConfig`
2. 在 `commands.js` 中添加对应的聊天指令（如需要）
3. **同步更新 `runtime_schema.json`**，把字段说明、约束、枚举值和（如有）废弃信息写进去
4. **同步更新 GUI Manager**：
   - `src/lib/types.ts` 的 `RuntimeConfig`
   - `src/pages/ConfigEditor.tsx` 的 `defaults` / `normalizeRuntimeConfig()`
   - 确认字段已经在对应章节真实渲染出来，而不是只存在于 schema 和类型里

否则 GUI Manager、自检和迁移提醒会和插件真实行为再次脱节。

请求队列相关字段的现有做法可参考：

* `requestQueue.maxConcurrent`：控制同时进行的 API 请求数量
* `requestQueue.maxPending`：控制最多允许排队等待的请求数量，`0` 表示不限制
* `requestQueue.overflowText`：队列已满时发给用户的提示文案，支持 `{ahead}` / `{running}` / `{pending}` / `{maxConcurrent}` / `{maxPending}` 占位符

收到请求后的动态状态提示逻辑目前位于 `listener.js`，队列容量与溢出保护逻辑位于 `queue.js`，如果你修改其中一侧，记得同步检查另一侧的提示文本和日志是否仍然一致。

图像节点相关字段的现有做法可参考：

* `runtime_config.json` 中的 `activeImageApiIndex`：控制当前默认图像节点
* `image_api_config.json`：维护独立图像节点列表
* `image_api_manager.html`：插件内自带的轻量图像节点管理工具
* `supportsEdit`：图像节点能力标记。xAI 默认支持生图+修图；OpenAI `gpt-image-2` 默认仅生图，修图命令会跳过该节点。

如果你新增了图像 provider 或图像节点字段，请同时检查：

1. `lib/config.js` 的默认值 / 迁移逻辑
2. `lib/commands.js` 的图像命令与列表/搜索输出
3. `image_api_manager.html` 的本地编辑逻辑
4. GUI Manager 的 `imageApi` 配置映射与图像节点列表

### 2. 多模型原生协议适配器

在 `lib/api.js` 的 `getAiReply` 方法中，我们针对不同的模型（OpenAI 兼容格式、OpenAI Responses API、Anthropic 原生格式、Gemini 原生格式）进行了**差异化发包**。

如果你想要接入一种全新格式的 API（例如百度文心、阿里百炼的特殊格式），请在 `aiType` 的判定分支中新增一段 `if (aiType === "your_type")` 的 Payload 组装逻辑与返回值解析逻辑。

**当前支持的协议格式：**

| aiType | 请求头 | 请求体特点 |
|--------|--------|------------|
| `openai` | `Authorization: Bearer <key>` | 标准 `messages` 数组（GUI 中显示为 `openai (completions)`） |
| `responses` | `Authorization: Bearer <key>` | `instructions` + `input`，支持 `input_text` / `input_image`（GUI 中显示为 `openai-response`） |
| `anthropic` | `x-api-key` + `anthropic-version` | `system` 独立、`messages` 结构 |
| `gemini` | `x-goog-api-key` | `contents`/`parts` 嵌套 + `systemInstruction` |

补充约定：

* `normalizeAiType()` 已兼容 `response` / `responses` / `openai-response` 三种写法。你在 GUI 或 JSON 里看到 `openai-response` 时，不要再额外开一套并行逻辑。
* xAI Web Search 只在 `responses` 分支附加 `tools: [{ type: "web_search" }]`。如果你在别的协议分支里也想接工具，先确认目标接口的真实契约，不要直接复制 xAI 的写法。

### 3. 风控拦截与 Fallback 降级机制（暗坑警告）

在编写发送消息的逻辑（`lib/sender.js` 的 `sendReply`）时请注意：QQ 协议下的"合并转发"经常会触发风控拦截。

Koishi 底层的 `session.send()` 遇到 1200 等风控拦截时，**有时并不会抛出 `Catch` 异常，而是静默返回一个空数组**。我们在代码中使用了严格校验返回值的机制来触发 Fallback 降级。如果你要修改发送逻辑，请务必保留并测试这种防吞锁的自救机制。

### 4. 智能路由引擎

`lib/api.js` 内置了三种路由策略：

| 模式 | 说明 |
|------|------|
| `failover` | 按序故障转移：主节点失败后依次尝试下一个 |
| `round-robin` | 全局轮询：每次请求使用不同节点 |
| `random` | 随机选择：从可用节点池中随机挑选 |

路由状态保存在 `state.routerState` 中（包含 `roundRobinIndex` 和 `failedNodes`）。新增路由策略时，修改 `selectNextNode()` 函数即可。

### 6. 图片渲染模块（新增）

`lib/render.js` 负责帮助菜单、人格列表、模型列表分页、状态面板、当前群状态的图片卡片渲染，严格依赖 Koishi 的 `puppeteer` service，而不是在插件内部自行启动浏览器。

开发时请注意：

* 只通过 `ctx.puppeteer.render()` 调用截图能力，保持和 `@seidko/koishi-plugin-puppeteer` 的用法一致。
* 图片渲染只用于**结构化、相对短，或已分页的输出**（当前为 `neko`、`neko.群聊人格列表`、`neko.私聊人格列表`、`neko.状态面板`、`neko.当前群状态`，以及可选开启的 `neko.模型列表` 图片分页）。
* `neko.UI 1/2/3` 用于切换图片主题；新增图片命令时请复用同一套 `uiStyle` 配置，不要再额外造一套并行配置。
* `neko.模型列表` 的图片模式必须保持分页，当前设计目标是每页固定数量、高密度多列布局，避免在 100+ 节点池下生成超长图片。
* 当 `puppeteer` 服务不可用、渲染失败、内容过长，或人格列表超出阈值时，**必须自动回退为纯文本**，不能让命令直接报错失效。
* 涉及群号、绑定关系、限流等敏感总览信息的命令（如 `neko.群绑定列表`），必须保持“仅主人可用”，且默认只展示必要范围，避免把所有监听群都暴露出来。

---

## 模块间调用关系

```
index.js（入口薄壳）
  ├── config.js → 加载所有 JSON 配置 → state.js
  ├── memes.js → 加载表情包目录 → state.js
  ├── utils.js → 加载指令避让列表 + 群友名单 → state.js
  ├── memory.js → 加载持久化记忆 → state.js
  ├── commands.js → 注册 45+ 指令（延迟 require api.js、config.js、memory.js、render.js）
  └── listener.js → 注册消息监听
        ├── utils.js（权限检查、指令避让）
        ├── parser.js（消息解析、图片提取）
        ├── queue.js（请求排队）
        ├── api.js（AI 调用）
        │     └── ratelimit.js（限流检查）
        ├── sender.js（消息发送 + 表情包）
        ├── history.js（日志记录）
        └── memory.js（记忆保存 + 压缩）
```

**关键原则**：`state.js` 是唯一的共享数据中心，所有模块通过它交换数据，不直接互相传递状态。

---

## 常见开发场景指南

### 场景 1：新增一个聊天指令

1. 在 `lib/commands.js` 的 `registerCommands(ctx)` 函数中添加指令注册：

```javascript
ctx.command('neko.你的指令 <参数>', '指令说明')
  .action(({ session }, 参数) => {
    if (!isMaster(session)) return '权限不足';
    // 你的逻辑...
    return '执行完成';
  });
```

2. 如果指令需要修改配置，使用 `saveRuntimeConfig()` 保存：

```javascript
const { saveRuntimeConfig } = require('./config');
state.runtimeConfig.yourNewField = newValue;
saveRuntimeConfig();
```

3. 如果指令涉及图片卡片展示，请同时提供文本 fallback，并评估是否需要接入 `uiStyle` 或分页逻辑（例如模型列表）。
4. 如果新增的指令名可能与其他 Koishi 插件冲突，在 `commands.json` 中添加避让词。

### 场景 2：接入新的 AI 协议格式

1. 在 `lib/api.js` 的 `callApiOnce()` 函数中找到协议分支：

```javascript
if (aiType === 'anthropic') {
  // Anthropic 专用逻辑
} else if (aiType === 'gemini') {
  // Gemini 专用逻辑
} else {
  // OpenAI 默认逻辑
}
```

2. 新增你的协议分支，注意：
   - 请求头（`headers`）的构造
   - 请求体（`body`）的 JSON 结构
   - 响应解析（提取 AI 回复文本的路径）

3. 在 `lib/api.js` 的连通性测试和 `lib/config.js` 的默认配置中同步支持新的 `aiType` 值。

如果你改的是 Responses / xAI 兼容，而不是全新协议，也请顺手检查：

1. `shouldUseXaiWebSearch()` 是否仍只在正确场景下返回 `true`
2. `extractResponsesText()` 是否兼容新的响应块结构
3. GUI Manager 的 `ApiManager.tsx` 下拉选项、URL 默认后缀提示和 `xaiWebSearchEnabled` 说明文案是否仍然一致

### 场景 3：新增一个运行时配置字段

1. 在 `lib/config.js` 的 `defaultRuntimeConfig` 中添加默认值
2. `loadAllConfigs()` 会自动将新字段合并到现有配置中（向下兼容）
3. 在 `runtime_schema.json` 中添加字段定义（标题、说明、类型、范围、枚举值、UI 元数据）
4. 如有旧字段替代关系，同时更新 `deprecatedFields` 或字段上的 `deprecatedValues`
5. 在 `lib/commands.js` 中添加修改该字段的聊天指令
6. 通过 `state.runtimeConfig.yourField` 在业务逻辑中读取

图片渲染相关字段的现有做法可参考：

* `uiStyle`：统一控制帮助菜单 / 人格列表 / 模型列表分页 / 状态面板的图片主题
* `modelListImageEnabled`：开关模型列表是否启用图片分页渲染

请求反馈相关字段的现有做法可参考：

* `apiTimeoutMs`：下游模型调用超时
* `sendProcessingNotice` / `processingNoticeText` / `processingNoticeDelayMs`：处理中提示（发送后 30 秒自动撤回，需平台支持删除消息）
* `sendFailureNotice` / `failureNoticeDetailMode` / `generationFailedText`：失败回报和错误详情粒度

群状态类指令的现有做法可参考：

* `neko.状态面板`：全局总览；若在群聊中调用，会额外拼接当前群上下文
* `neko.当前群状态`：专门查看本群监听、绑定与限流状态
* `neko.群绑定列表`：只展示已配置独立人格或独立模型绑定的群聊总览，适合作为主人运维命令

### 场景 4：修改消息发送行为

`lib/sender.js` 的核心流程：

```
AI 回复文本
  → formatForQQ()：Markdown 清洗为 QQ 友好格式
  → 拟人分段算法：按标点切分 + 概率合并
  → 判断是否合并转发（forwardStrategy + 字数/段数阈值）
  → 尝试合并转发 → 失败则 Fallback 逐段发送
  → 打字延迟模拟
  → 概率发送表情包
```

修改时请保留 Fallback 降级链路，确保消息不会因风控而丢失。

---

## 报告 Bug

如果你在使用或二开过程中遇到了错误、崩溃或死循环，请在提交 Issue 前确认以下几点：

1. **搜索现有的 Issues**：看看是否已经有人提出了相同的问题。
2. **提供详细的环境信息**：
   - Node.js 版本和 Koishi 框架版本。
   - 正在使用的适配器类型（如 OneBot, Satori, NapCat 等）。
   - 你使用的 AI 模型名称及底层协议类型（如 openai, gemini, anthropic）。
3. **提供复现步骤**：详细描述你是如何触发这个 Bug 的。
4. **附带日志**：尽可能提供控制台的完整日志（尤其是本插件自带的 `[Neko]` 前缀日志）。**提交前请务必打码隐藏你的 API Key 和真实的 QQ 号/群号！**

---

## 提出新功能 (Feature Request)

如果你有很棒的想法可以提升这个插件的体验，欢迎提交 Issue 告诉我们！
- 清晰地描述这个功能是什么。
- 解释为什么这个功能对大家有帮助。
- 如果你有初步的实现思路（甚至是伪代码），非常欢迎在 Issue 中一起探讨！

---

## 本地开发与调试

### 1. 准备环境
确保你已经安装了 [Node.js](https://nodejs.org/) (推荐 LTS 版本) 和一台运行中的本地 Koishi 实例。

如果你要测试图片卡片功能，请额外在 Koishi 环境中安装并启用：

```bash
npm install @seidko/koishi-plugin-puppeteer
```

### 2. Fork 与 Clone
1. 点击本项目右上角的 **Fork** 按钮，将代码 Fork 到你自己的 GitHub 账号下。
2. 将代码 Clone 到你的本地电脑：
```bash
git clone https://github.com/你的用户名/koishi-plugin-Enhanced-NekoAI.git
cd koishi-plugin-Enhanced-NekoAI
```

### 3. 安装依赖并链接到测试环境 (npm link)

为了方便调试，建议使用 `npm link` 将本地正在开发的插件软链接到你的 Koishi 测试项目中：

```bash
# 1. 在你 Clone 下来的插件目录下执行：
npm install
npm link

# 2. 切换到你的 Koishi 测试机器人项目目录下：
cd path/to/your/koishi-app
npm link koishi-plugin-Enhanced-NekoAI
```

### 4. 实时调试

* 在你的 Koishi 项目中启用该插件。
* 每次你在本地修改了 `lib/` 目录下的任何模块文件，只需**重启 Koishi 实例**即可加载最新代码。
* 如果你只是修改了 JSON 配置文件来测试逻辑，在 QQ 聊天窗口发送 `neko.重载配置` 即可瞬间生效，无需重启！
* 可通过 `neko.日志级别 debug` 指令开启详细日志输出，方便追踪问题。

---

## 项目结构一览

```
koishi-plugin-Enhanced-NekoAI/
├── index.js                    ← 入口文件（~40 行薄壳）
├── package.json                ← Koishi 插件元信息
├── lib/                        ← 15 个功能模块
│   ├── state.js                ← 全局状态单例
│   ├── logger.js               ← 分级日志
│   ├── config.js               ← 配置管理（加载/保存/默认值/Schema）
│   ├── utils.js                ← 工具函数
│   ├── parser.js               ← 消息解析
│   ├── sender.js               ← 消息发送
│   ├── api.js                  ← AI API 调用
│   ├── queue.js                ← 请求队列
│   ├── ratelimit.js            ← 群聊限流
│   ├── history.js              ← 历史日志
│   ├── memory.js               ← 长期记忆
│   ├── memes.js                ← 表情包
│   ├── commands.js             ← 指令注册
│   ├── listener.js             ← 事件监听
│   └── render.js               ← 帮助菜单 / 人格列表图片卡片渲染
├── runtime_config.json         ← 核心运行配置
├── api_config.json             ← API 节点配置
├── group_personality.json      ← 群聊人格库
├── private_personality.json    ← 私聊人格库
├── commands.json               ← 指令避让字典
├── group_usage_counts.json     ← 限流计数器
├── chat-history/               ← 对话日志目录
├── memory/                     ← 长期记忆目录
│   ├── group/                  ← 群聊记忆
│   └── private/                ← 私聊记忆
└── neko_memes/                 ← 表情包目录（9 个情绪分类）
```

---

## 提交 Pull Request (PR)

我们非常期待你的代码提交！在提交前，请遵循以下流程：

1. **创建分支**：基于 `main` 分支创建一个新的功能或修复分支。
```bash
git checkout -b feature/your-awesome-feature
# 或者修复 bug 分支
git checkout -b fix/issue-number
```

2. **编写代码与注释**：
* 保持代码风格与现有代码一致。
* **写好注释**！特别是涉及复杂的正则表达式清洗、多模态消息解析、或是绕过 Koishi 底层某些机制的 Hack 写法，一定要在旁边写明原因。

3. **提交更改**：提交信息 (Commit Message) 请尽量简明扼要。
```bash
git commit -m "feat: 增加对 GPT-SoVITS 语音接口的初步支持"
```

4. **推送到远程仓库**：
```bash
git push origin feature/your-awesome-feature
```

5. **开启 PR**：回到 GitHub 页面，点击 `Compare & pull request` 按钮，详细填写 PR 描述。

---

## 进阶开发规范提示

* **控制台日志透明度**：本插件非常注重给服主提供直观的运行状态。如果你新增了一个复杂的网络请求或处理流程，请使用 `lib/logger.js` 提供的分级日志方法（`logger.debug()`、`logger.info()`、`logger.warn()`、`logger.error()`、`logger.critical()`）打印必要的状态，不要直接使用 `console.log`。
* **Koishi 元素构造**：尽量遵守 Koishi 的生态标准，优先使用 `h` (h 函数，如 `h.text()`, `h('image', {url: ...})`) 元素进行消息体构建，避免直接拼接底层平台（如 CQ码）的特异性字符串，以保证跨平台的兼容性。
* **JSON 配置向下兼容**：新增配置字段时，务必在 `config.js` 的 `defaultRuntimeConfig` 中提供默认值。`loadAllConfigs()` 会自动将新字段合并到用户现有的配置文件中，无需用户手动添加。
* **避免全局变量**：所有需要跨模块共享的状态必须通过 `state.js` 管理。如果你需要新增共享状态，在 `state.js` 中添加字段并在文件顶部注释中说明用途。
* **图片渲染要可降级**：凡是接入 `lib/render.js` 的命令，都必须保留文本 fallback，确保 `puppeteer` 缺失、截图失败、内容过长时插件仍可正常工作。
* **不要同步用户本地数据**：开源仓库中不要提交真实的 `runtime_config.json`、`api_config.json`、聊天记录、长期记忆、旧版 HTML 工具或任何包含私有身份信息的示例数据。

---

再次感谢你的贡献，让我们一起打造最强、最通人性的开源 AI 聊天伴侣！
