# Novel Helper

桌面端小说写作助手：基于 **Electron** 的编辑器，集成 **OpenAI 兼容 API** 的对话、工作区文件工具，以及带 **DAG 版本图** 的章节快照与分支管理。对话与长期记忆存放在工作区下的 **`.novel`** 目录中（请勿手动删除，除非你清楚后果）。

## 功能概览

- **工作区**：选择一个本地文件夹作为根目录；正文路径均相对于该根目录。
- **Monaco 编辑器**：打开、编辑工作区内的文本文件；AI 工具写入前会请求编辑器缓冲落盘，减少与磁盘不一致。
- **版本与分支**：检查点（checkpoint）将当前工作区与对话截断位置记入版本图；可在节点间跳转、分叉分支；删除节点会联动清理相关数据（具体行为以当前实现为准）。
- **AI 对话**：流式输出；模型可调用工作区工具（读取、列表、搜索、补丁、整文件写入、删除等），成功写入后可触发自动快照（见主进程逻辑）。生成中可「停止生成」：中止后续输出，已落盘的工具写入保留，且不会创建本轮末尾的 AI 快照。右侧以**标签页**维护多条并行对话：每条为同一 **DAG 版本分支** 下的独立 **thread**（`memory.db` 中 `messages.thread_id`）；标签的打开/关闭与标题持久在 **`chat_threads`** 表（按 `branch_id` 隔离），切换分支只加载该分支的标签与消息；关闭的标签可从「已关闭」下拉再次打开。不为每条对话新建 DAG 分支；仅当「查看的历史节点之后仍有版本」时，**发送消息或创建检查点**前须先完成新建分支；**新建对话标签**仍可随时添加。首轮用户发送后根据首句自动生成标签标题。
- **记忆**：可选的摘要与向量检索（embedding），设置项中可开关与调参。

## 环境要求

- **Node.js**（建议当前 LTS）
- **npm** 或兼容的包管理器
- 使用对话功能需要配置 **API Key**（设置中填入）；默认基址为 OpenAI `v1`，也可改为其他兼容服务地址。

## 快速开始

```bash
npm install
npm run dev
```

开发模式会启动 Electron + Vite 热更新。

## 构建

仅编译主进程、预加载与渲染层（不打包安装包）：

```bash
npm run build:app
```

生成可分发安装包（Windows 下默认为 NSIS，输出在 `release/`）：

```bash
npm run build
```

依赖中包含原生模块 **better-sqlite3**。若在升级 Electron 或更换平台后遇到原生模块加载问题，可尝试：

```bash
npm run rebuild:native
```

**Windows 未签名打包**：默认 `npm run build` 会通过 `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过自动代码签名，避免拉取 `winCodeSign` 工具时在解压阶段创建符号链接失败（常见报错为 *Cannot create symbolic link / 客户端没有所需的特权*）。若你需要正式签名，请配置证书并去掉该环境变量，或在系统设置中开启「开发者模式」/ 以具备创建 symlink 权限的方式构建。

## 项目结构（简要）

| 路径 | 说明 |
|------|------|
| `src/main/` | Electron 主进程：IPC、文件服务、版本存储、LLM 客户端、记忆库 |
| `src/renderer/` | React + Monaco 界面 |
| `src/preload/` | 预加载脚本，暴露安全的 `novel` API |
| `src/shared/` | 主进程与渲染进程共用的类型与常量 |
| `out/` | `build:app` 产物（勿提交） |
| `release/` | `electron-builder` 安装包输出（勿提交） |

工作区根目录下的 **`.novel/`** 由应用维护（版本元数据、记忆数据库等），AI 工具层会禁止直接读写该目录。

## 设置说明

在应用内 **Settings** 中可配置：

- OpenAI 兼容 **`openAiBaseUrl`**、**`openAiApiKey`**
- **`chatModel`** / **`embeddingModel`**
- 记忆相关：**最近消息条数**、**摘要频率**、**检索 Top-K**、**是否启用记忆**

设置会持久化到用户数据目录（由 Electron 管理），与工作区路径无关。

## 技术栈

- **Electron**、**electron-vite**、**Vite**、**TypeScript**
- **React 18**、**Monaco Editor**
- **better-sqlite3**（对话与 embedding 存储）

## 许可证

见仓库根目录的 [LICENSE](LICENSE) 文件。
