# PaperBridge · 开源文献阅读翻译工具

在浏览器里读论文：**划词翻译、全文双语对照、AI 解释与问答、高亮笔记、术语表**。接入你自己的 API，所有文献、笔记和 Key 都只保存在本地浏览器。

## 功能

| 功能 | 说明 |
| --- | --- |
| 📖 PDF 阅读 | 基于 pdf.js，支持缩放（Ctrl+滚轮）、页码跳转、记住阅读位置、大文件按需渲染 |
| 🔤 划词翻译 | 选中文字 → 浮动工具栏「翻译 / 解释」，流式输出；可设为「选中即翻译」 |
| 📄 保留排版的全文翻译 | 类似 PDFMathTranslate：点「全文翻译」后，阅读器以**双栏**显示原文页与译文页（也可只看译文）。译文直接替换原文、保留原排版：图表、公式、页眉页脚不动，行内公式保留原字形（含分数线/根号）；横排的整页表格（旋转 90° 排版）和带旋转属性的横向页同样支持；被分栏或分页截断的句子与它的后半段合在一起翻译，再按位置分回两处；译文漏句、丢数字、丢公式时自动带原因重试；从当前页开始逐页生成，段落一译出就显示在侧栏；多个请求并发（设置里的「并发数」，默认 5，校验重译也计在内，不会超出接口的并发上限），22 页的论文约 3 分钟译完；译过的页面缓存在本地。可导出「仅译文 / 左右对照 / 双语交替」PDF |
| 📑 全文对照 | 自动识别段落（支持双栏论文、去连字符），与上面的全文翻译同时完成；侧栏逐段原文/译文对照，悬停高亮 PDF 对应段落，可导出 Markdown |
| 💬 AI 问答 | 基于整篇论文提问，内置「总结全文 / 方法详解 / 创新与局限 / 关键术语」，支持 Markdown 与 LaTeX 公式 |
| 🖍 高亮笔记 | 五色高亮、批注、翻译高亮段落，导出 Markdown |
| 📚 术语表 | 全局 / 单篇术语，自动注入大模型提示词保证译名一致；全文翻译前由大模型自动提取本文关键术语（可在设置中关闭，可在「术语」面板修改）；CSV 导入导出 |
| 💾 缓存 | 翻译结果按「服务 + 模型 + 语言 + 术语 + 提示词」缓存在 IndexedDB，重复打开不再消耗 token |
| 📤 导出 | 译文 PDF；双语对照 / 仅译文 Markdown，笔记 Markdown |
| 🗂 文献库与多标签 | 类 Zotero 7 三栏界面（可调宽分类树 + 底部标签筛选器 + 多列可排序表格 + 折叠检视面板）；顶部多文献标签栏支持同时打开并无缝切换多篇论文（切回文库不中断全文翻译、中键后台打开/关闭、拖拽排序、`Alt+1..9` 快捷键）；按 DOI / arXiv / 链接导入并自动下载 PDF，导入 BibTeX（Zotero 等）；元数据自动补全（Crossref / arXiv）；导出 BibTeX / APA / GB/T 7714 引用；全文检索；笔记汇总；整库备份与恢复 |

| ☁️ 多端云同步 | 可选接入自托管零依赖同步服务（`sync/server.mjs`）：同一账号在网页版与 Windows/macOS/Linux 桌面端双向同步文献、PDF（SHA-256 去重）、分类、标签、笔记、术语、对话与翻译缓存；API 配置使用账号密码在本地 AES-256-GCM 端到端加密后同步 |

## 支持的 API

| 类型 | 服务 | 浏览器直连 |
| --- | --- | --- |
| OpenAI 兼容 | OpenAI、DeepSeek、Kimi、通义千问、智谱 GLM、硅基流动、OpenRouter、Ollama / vLLM / LM Studio 本地模型… | ✅（个别服务商需代理） |
| Anthropic | Claude | ✅ |
| Google | Gemini | ✅ |
| 机器翻译 | Google Cloud Translation | ✅ |
| 机器翻译 | DeepL、百度翻译、有道智云 | ❌ 需要[跨域代理](proxy/README.md) |

在「设置 → API 服务」中可直接点击常用服务商卡片填入 Key 一键「测试并保存」，也支持在「一键粘贴导入」框内直接粘贴 `URL + Key`、`.env`、`curl` 命令或导出的配置 JSON 自动解析填入。可以分别指定「翻译服务」和「问答用大模型」，例如用 DeepL 翻译、用 DeepSeek 问答。

## 快速开始

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

构建静态站点（可部署到 GitHub Pages / Vercel / Netlify / 任意静态服务器，`base` 已设为相对路径）：

```bash
pnpm build        # 输出到 dist/
```

需要使用 DeepL / 百度 / 有道时，另开终端运行零依赖代理：

```bash
pnpm proxy        # = node proxy/server.mjs，默认 http://127.0.0.1:8787
```

然后在对应 API 的设置里勾选「通过跨域代理发送请求」。详见 [proxy/README.md](proxy/README.md)（含 Docker 与 Cloudflare Workers 部署）。

## 桌面客户端（Windows / macOS / Linux）

可在 [Releases](https://github.com/royhang/PaperBridge/releases) 直接下载 Windows 免安装版压缩包（解压后运行 `PaperBridge.exe`），或按下方命令自行构建。

`desktop/` 是基于 Electron 的客户端，界面和功能与网页版相同，另外：

- **内置跨域代理**：任何 API（包括不支持跨域的学校/公司接口、DeepL、百度、有道）和论文下载都直接可用，无需运行 `pnpm proxy`；
- **字体随应用打包**，全文翻译离线可用（只有调用翻译 API 需要联网）；
- 文献、译文缓存、笔记都保存在本机；
- 可用「打开方式 → PaperBridge」或把 PDF 拖到程序图标上直接打开。

```bash
pnpm desktop          # 构建网页并以桌面窗口启动（开发用）
pnpm desktop:win      # 打包 Windows 免安装版 → desktop/release/PaperBridge-<版本>-win-x64.zip
pnpm desktop:linux    # 打包 Linux AppImage
pnpm desktop:mac      # 打包 macOS dmg（需在 macOS 上运行）
```

首次运行前在 `desktop/` 里执行一次 `pnpm install`。国内网络下载 Electron 较慢时可设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

## 隐私

- PDF、翻译缓存、笔记、术语、对话保存在浏览器（或桌面客户端）的 IndexedDB；设置与 API Key 保存在 localStorage。
- 请求从浏览器直接发往你配置的服务商（或你自己运行的代理），项目本身没有任何后端。
- 在公共电脑上使用后，可在「设置 → 数据」中清理。

## 开发

```bash
pnpm test         # 单元测试（providers / 段落解析）
pnpm test:proxy   # 代理冒烟测试
pnpm lint
```

```
src/
  providers/   各家 API 适配器（统一的 LLMProvider / MTProvider 接口，SSE 流式解析）
  pdf/         pdf.js 加载、段落提取（双栏检测、阅读顺序、去连字符）
  services/    翻译（缓存、术语、批量 <seg> 协议）、全文翻译调度、导出
  store/       zustand 状态（设置持久化 / 阅读器状态）
  db/          Dexie (IndexedDB) 数据表
  components/  阅读器、侧栏面板、设置
proxy/         Node 与 Cloudflare Workers 版跨域代理
```

### 新增一个 API 服务商

1. 在 `src/providers/types.ts` 的 `ProviderKind` 中加一个类型；
2. 新建 `src/providers/xxx.ts`，实现 `LLMProvider.chat()`（返回文本增量的 AsyncIterable）或 `MTProvider.translate()`；只使用 `ctx.fetch`，这样会自动支持代理；
3. 在 `src/providers/index.ts` 的 `createProvider` 和 `PROVIDER_PRESETS` 中注册，并在 `__tests__` 中加测试。

## License

MIT

### 致谢

- 「译文 PDF」的思路（移除原文字、在原段落框内重排译文、行内公式以占位符保留并按原字体重绘）参考了 [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate)。PDFMathTranslate 采用 AGPL-3.0 许可，本项目没有使用其代码，而是用 TypeScript（pdf-lib + 自研内容流解析）独立实现。
- 中文字体：[Noto Serif SC](https://fonts.google.com/noto/specimen/Noto+Serif+SC)（SIL Open Font License 1.1），构建时由 `scripts/fetch-fonts.mjs` 下载，并用 [HarfBuzz](https://github.com/harfbuzz/harfbuzz) 子集化后嵌入 PDF。
