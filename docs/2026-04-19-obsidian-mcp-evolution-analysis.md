# obsidian-mcp 演进分析

## 目标

本文档分析三个问题：

1. `obsidian-mcp` 当前已经具备哪些能力，边界在哪里。
2. `Claudian` 中哪些能力值得借鉴并整合到 `obsidian-mcp`。
3. `obsidian-mcp` 下一步应该如何迭代，既补足高价值能力，又避免把项目做成另一个聊天插件。

结论先行：

- `obsidian-mcp` 已经覆盖了 Vault 文件层的基础 CRUD、搜索、标签管理、多 vault、安全校验，基础是成立的。
- `Claudian` 最值得借鉴的不是聊天 UI，而是几类“可被工具化的中间能力”：精细编辑抽象、上下文解析、命令/技能发现、配置分层、可测试的边界设计。
- `obsidian-mcp` 下一阶段不应该演进成 provider runtime 或侧边栏产品，而应该演进成“面向 code agent 的 Obsidian 操作底座”。

## 一、obsidian-mcp 当前能力盘点

### 1.1 已有能力

基于 `/Users/bytedance/githubRepo/obsidian-mcp` 当前代码，`obsidian-mcp` 已具备以下能力：

- 多 vault 接入与命名管理
- 本地路径安全校验与目录边界保护
- 笔记读取：`read-note`
- 笔记创建：`create-note`
- 笔记编辑：`edit-note`
- 笔记删除：`delete-note`
- 笔记移动/重命名：`move-note`
- 目录创建：`create-directory`
- Vault 搜索：`search-vault`
- 标签增删改：`add-tags`、`remove-tags`、`rename-tag`、`manage-tags`
- Vault 资源与 Prompt 暴露：`resources`、`prompts`

### 1.2 当前做得比较好的地方

`obsidian-mcp` 的优点不在“功能很多”，而在于它已经有一套相对清晰的底层约束：

- 安全边界明确：对路径、隐藏目录、系统目录、network path、路径重叠做了强校验。
- 多 vault 模型清晰：通过 `vault name -> resolved path` 管理，而不是把所有路径逻辑散落在各个 tool 中。
- tool 注册方式统一：所有工具复用 `createTool` 和统一的 schema 校验。
- 标签处理相对成熟：已经有 frontmatter 解析、inline tag 处理、批量 rename 的基础设施。
- 链接维护已有起点：`move-note` 已能在 vault 内更新一部分 markdown links。
- 有 prompt/resources 视角：说明项目不只是“文件操作脚本”，已经开始考虑 agent 使用体验。

### 1.3 当前能力边界

当前 `obsidian-mcp` 的能力本质上仍停留在“文件级操作”：

- 读整篇 note
- 写整篇 note
- append/prepend/replace 整篇内容
- 按文件移动和删除
- 做文本搜索
- 管标签

这意味着它对 code agent 来说仍缺几类关键抽象：

- 缺“局部编辑”能力，只能整篇替换或粗粒度追加。
- 缺“结构化 frontmatter”能力，目前主要围绕 tag，不是通用 metadata 操作。
- 缺“知识图谱”能力，无法显式处理 backlinks、wikilinks、未解析链接、MOC 入口。
- 缺“目录/文件发现”能力，除搜索外，几乎没有稳定的列举接口。
- 缺“计划型写入”能力，例如 daily note、inbox capture、topic placement、source-to-note synthesis。
- 缺“预览/审批”能力，工具执行通常直接落盘，agent 难以先看 diff 再决定。

### 1.4 当前实现上的明显问题

这些问题不一定马上阻塞，但说明下一步演进应先补底座：

- `edit-note` 只支持 `append` / `prepend` / `replace`，粒度过粗。
- `read-note` 在内部复用了 `operation: 'edit'` 作为返回类型，说明结果模型还不够准确。
- 工具返回普遍是格式化文本，结构化字段较少，不利于 agent 做二次决策。
- `move-note` 的链接更新主要基于 basename 正则替换，复杂路径、别名、同名笔记场景容易误伤或漏改。
- 标签工具相对强，但 frontmatter 其余字段没有对应能力，导致 metadata 自动化不完整。
- 资源层目前只暴露 vault 级资源，没有把目录、笔记图谱、索引页这类更高价值对象暴露出来。

## 二、Claudian 中值得借鉴的能力

## 2.1 不应该借鉴的部分

先明确什么不该搬。

`Claudian` 的大量代码服务于“在 Obsidian 内嵌 provider 聊天体验”，这部分不适合搬进 `obsidian-mcp`：

- 侧边栏聊天 UI
- 多 Tab 会话管理
- provider runtime 适配层（Claude/Codex/Coco）
- 流式消息渲染
- plan mode / rewind / fork 这类会话行为
- 聊天历史存储与 transcript 管理
- 图片上下文、状态栏、输入工具条

这些能力属于“聊天客户端产品层”，而不是“MCP 工具底座层”。

如果把这些东西带进 `obsidian-mcp`，项目会偏离当前最有价值的方向：为 code agent 提供稳定、结构化、可组合的 vault 操作接口。

## 2.2 值得借鉴的部分

### A. 精细编辑抽象

`Claudian` 里最值得借鉴的是“编辑不是只有全文替换”这个思路。

它已经把编辑抽象成了几种不同语义：

- selection edit
- cursor edit
- instruction refine
- title generation
- file context

这些概念不需要照搬 UI，但可以翻译成 `obsidian-mcp` 的新工具能力：

- `patch-note`
  - 按唯一文本片段替换
  - 按标题区块替换
  - 插入到某个标题前后
- `generate-title`
  - 不是让 MCP 生成内容，而是提供一个对 note 内容的标题建议接口
- `rewrite-section`
  - 基于 section/title 的局部重写

这是 `obsidian-mcp` 最有价值的演进方向之一，因为它会直接提升 code agent 的可用性。

### B. 上下文与范围意识

`Claudian` 在聊天侧很重视上下文组织：

- 文件上下文
- 选区上下文
- 光标上下文
- 外部上下文扫描

这可以转化为 `obsidian-mcp` 的“结构化上下文工具”：

- `read-note-section`
  - 读取指定标题下的章节
- `read-note-around`
  - 按匹配文本读取上下文窗口
- `search-links`
  - 找出某个 note 的出链与入链
- `list-related-notes`
  - 根据链接、标签、目录邻近性给出候选相关笔记

这样 agent 在改某一段内容时，不必每次读整篇 note。

### C. 可扩展的目录发现与命令发现

`Claudian` 的 `ClaudeCommandCatalog` / `CodexSkillCatalog` 体现了一个重要思路：

- “用户定义能力”需要可发现、可列举、可筛选

对应到 `obsidian-mcp`，最值得借鉴的是两件事：

- 目录/文件/模板发现能力
- prompt/tool 组合能力

这可以演进为：

- `list-directory`
  - 列出某个路径下的文件和目录
- `list-notes`
  - 按目录、标签、frontmatter 条件列出 notes
- `list-mocs`
  - 约定式发现 MOC/index 页面
- `list-templates`
  - 如果 vault 有模板目录，向 agent 明确暴露

这类工具比“再加一个聊天 UI”更能提升 agent 对 vault 的导航能力。

### D. 配置分层与边界清晰

`Claudian` 在 provider 侧有一个值得学习的习惯：共享配置和 provider 配置分离。

对 `obsidian-mcp` 来说，对应的不是 provider，而是能力域：

- vault 范围配置
- tool 行为配置
- 安全策略配置
- agent 友好配置

建议后续将配置分层为：

- server-level：启动时的 vault 列表、安全限制、超时
- vault-level：某个 vault 的模板目录、inbox 路径、daily note 路径、MOC 入口
- tool-level：是否允许 destructive 操作、是否默认 dry-run、是否启用 link rewrite

这能避免后续每加一个工具，就把行为逻辑塞进单个文件。

### E. 可测试的边界设计

`Claudian` 最大的工程价值之一是边界比较清楚，很多能力都有单测。

`obsidian-mcp` 现在适合借鉴这种设计方法，而不是借鉴产品层行为：

- 将 path/security 单独作为稳定底座
- 将 note mutation 抽成独立层
- 将 link graph/metadata 独立成工具域
- 将 prompt/resources 看作 agent-facing API，而不是附属功能

这会让后续新增工具时不需要频繁复制路径处理、文件读写、错误格式化逻辑。

## 三、Claudian 能力映射到 obsidian-mcp 的建议

下面按“是否建议整合”来分类。

### 3.1 建议直接借鉴

#### 1. 局部编辑能力

建议程度：最高

原因：

- 这是 `obsidian-mcp` 当前最大的能力缺口。
- 对 code agent 的帮助最大。
- 不依赖 Obsidian UI，也不依赖 provider runtime。

建议新增：

- `patch-note`
- `replace-in-note`
- `insert-into-note`
- `read-note-section`

#### 2. 上下文读取能力

建议程度：高

原因：

- 能显著降低 agent 为了改一小段内容而读取整篇文档的成本。
- 天然适合 MCP 工具形态。

建议新增：

- `read-note-section`
- `read-note-around`
- `list-note-headings`

#### 3. 目录与索引发现能力

建议程度：高

原因：

- 当前 agent 在 vault 导航上主要靠搜索，路径感知不足。
- 这类能力能直接支撑“把笔记写到哪里”这类决策。

建议新增：

- `list-directory`
- `list-notes`
- `find-moc`
- `find-daily-note`

#### 4. 通用 frontmatter 管理

建议程度：高

原因：

- 当前 tag 能管，但 metadata 不能系统管，自动化断层明显。

建议新增：

- `read-frontmatter`
- `update-frontmatter`
- `merge-frontmatter`
- `remove-frontmatter-keys`

### 3.2 建议选择性借鉴

#### 1. 标题生成与内容摘要

建议程度：中

可以做，但更适合作为 prompt 或轻量 helper，而不是强依赖工具。

更合理的方式：

- 暴露 prompt 模板，而不是在 MCP 里做模型能力
- 例如提供 “summarize note for filing” 或 “convert source note to evergreen note” prompt

#### 2. 技能/命令发现

建议程度：中

不是 `obsidian-mcp` 的第一优先级，但可以借鉴其“可发现性”思想。

更适合演进为：

- 模板目录发现
- 标准笔记目录发现
- 约定路径发现（`inbox/`, `notes/`, `moc/`, `sources/`）

#### 3. 审批/预览流程

建议程度：中高

这类能力很有价值，但不必做成 `Claudian` 那种完整交互流。

更适合 `obsidian-mcp` 的形式：

- `dryRun`
- `previewDiff`
- `requireExactMatch`
- `createBackup`

让调用方决定是否真正落盘。

### 3.3 不建议整合

以下内容不应成为 `obsidian-mcp` 的演进方向：

- 聊天消息流渲染
- provider 适配层
- 多模型管理
- plan mode / rewind / fork
- UI 状态管理
- 会话持久化
- 图片上下文和输入工具栏能力

这些能力会把项目从“vault tool server”拉向“聊天客户端”，得不偿失。

## 四、obsidian-mcp 当前缺口与下一步优先级

## 4.1 P0：立刻值得做的能力

### P0-1. 通用 frontmatter 工具

目标：

- 让 metadata 自动化从“只能改 tags”升级到“可完整管理 note metadata”

建议工具：

- `read-frontmatter`
- `update-frontmatter`
- `merge-frontmatter`
- `remove-frontmatter-keys`

价值：

- 直接支持 type/topic/source/status/aliases/created 等字段自动化
- 为后续 inbox、daily、MOC、source synthesis 奠定基础

### P0-2. 局部编辑工具

目标：

- 解决整篇 replace 粒度过粗的问题

建议工具：

- `patch-note`
  - 按旧文本精确替换
  - 可选 `replaceAll`
- `replace-note-section`
  - 按标题替换整个 section
- `insert-note-content`
  - 在标题前/后插入

价值：

- 显著降低误改风险
- 提升 agent 修改已有长文档时的成功率

### P0-3. 目录列举与标题列举

目标：

- 让 agent 有稳定导航能力，而不只是全文搜索

建议工具：

- `list-directory`
- `list-notes`
- `list-note-headings`

价值：

- 让 agent 能先理解 vault 结构，再做写入决策
- 能服务于“该把这篇笔记放哪”的场景

### P0-4. 更结构化的 tool 返回

目标：

- 不再只返回格式化文本，增加机器可消费字段

建议：

- 每个工具统一返回：
  - `success`
  - `path`
  - `operation`
  - `changed`
  - `warnings`
  - `details`

价值：

- 降低上层 agent 对字符串解析的依赖
- 为后续组合工具和自动重试打基础

## 4.2 P1：高价值但不必第一天做

### P1-1. 链接图谱能力

建议工具：

- `get-backlinks`
- `get-outgoing-links`
- `find-unresolved-links`
- `rename-note-with-link-audit`

说明：

当前 `move-note` 已经会修改一部分链接，但不够可靠，也没有审计视角。

P1 阶段应该把“链接更新”升级为“链接图谱与审计能力”。

### P1-2. Vault 约定式导航能力

建议工具：

- `find-daily-note`
- `find-or-create-daily-note`
- `find-topic-folder`
- `find-moc`
- `classify-note-destination`

说明：

这类能力非常适合你当前的工作流，因为你希望 agent 直接操作 Obsidian vault，而不是依赖插件 UI。

### P1-3. 预览与安全控制

建议能力：

- destructive tool 的 `dryRun`
- `previewDiff`
- `backupMode`
- `failIfExists`
- `failIfMultipleMatches`

说明：

这会让 `obsidian-mcp` 从“会写文件”升级到“可被放心自动化调用”。

## 4.3 P2：可选增强

### P2-1. Prompt 体系增强

建议方向：

- 提供更像工作流模板的 prompts，而不是只提供 vault 列表 prompt

例如：

- 将 source note 总结成 evergreen note
- 将临时想法归档到 inbox note
- 从 meeting note 提炼 tasks 和 follow-ups

### P2-2. 批量操作能力

建议工具：

- `read-multiple-notes`
- `batch-update-frontmatter`
- `batch-move-notes`

说明：

批量工具很有价值，但建议建立在 P0 的结构化工具和前置安全控制之上。

### P2-3. 资源层增强

建议方向：

- 将目录树、MOC 索引、daily note 索引、标签统计等内容作为资源暴露

说明：

资源层适合暴露“偏静态、可浏览”的信息，不必什么都做成 tool。

## 五、推荐的架构演进方式

## 5.1 不要按“再加一个 tool 文件”的方式横向堆功能

如果继续按当前模式扩展，工具数量一多，问题会越来越明显：

- 每个 tool 自己处理 note 路径
- 每个 tool 自己做文件读写
- 每个 tool 自己组织返回文本
- frontmatter、section、link graph 的逻辑会重复散落

建议改成按能力域拆层。

## 5.2 建议的内部分层

### A. 基础层

- path/security
- vault resolution
- file IO
- response schema

这层当前已经有一部分，建议保持稳定。

### B. note model 层

新增统一抽象：

- parse note
- read note
- write note
- parse frontmatter
- split sections
- normalize headings
- extract links

这层会成为后续大多数工具的共享底座。

### C. mutation 层

新增统一变更原语：

- replace text
- replace section
- insert before/after section
- merge frontmatter
- remove metadata keys
- rename note with audit

有了这层，tool 只是“暴露接口”，而不是自己实现全部业务。

### D. tool/prompt/resource 层

- tool 负责参数校验与返回结构
- prompt 负责把底层能力组合成 agent 可用工作流
- resource 负责暴露索引型、浏览型信息

这是最适合 `obsidian-mcp` 的定位。

## 六、推荐的迭代顺序

建议按下面顺序推进，而不是同时做很多点。

### 第一阶段：把底座补齐

目标：

- 让 agent 能安全地改已有笔记，而不是只能粗暴覆盖

交付：

- 通用 frontmatter 工具
- 局部编辑工具
- 标题列举与目录列举
- 结构化返回模型

### 第二阶段：把 vault 导航能力补齐

目标：

- 让 agent 能理解“笔记放哪里、相关笔记有哪些、入口页在哪里”

交付：

- backlinks / links / unresolved links
- MOC / daily / topic 发现工具
- 更强的搜索与列举组合

### 第三阶段：把 agent 工作流体验补齐

目标：

- 让 `obsidian-mcp` 成为 code agent 的知识库操作底座

交付：

- workflow prompts
- dry-run / diff preview
- 批量工具
- 资源层增强

## 七、建议的非目标

为了避免项目失焦，建议明确以下非目标：

- 不做聊天 UI
- 不做 provider runtime 适配
- 不做多模型管理
- 不做会话历史产品
- 不把 Obsidian 插件行为搬进 MCP

`obsidian-mcp` 最应该做的是：

- 提供稳定、安全、结构化的 vault 操作能力
- 让 code agent 能直接把 Obsidian 当作知识库工作目录
- 把“定位、读取、局部修改、metadata 管理、链接导航”做扎实

## 八、最终建议

如果只选三个最值得优先投入的方向，我的排序是：

1. `局部编辑能力`
2. `通用 frontmatter 管理`
3. `目录/标题/链接导航能力`

这三类能力一旦补齐，`obsidian-mcp` 就会从“能读写 note 的 MCP”升级为“真正适合 code agent 使用的 Obsidian 操作底座”。

相比之下，把 `Claudian` 的聊天 UI、provider runtime、会话流等能力搬过来，收益低且会明显增加复杂度，不建议作为演进方向。
