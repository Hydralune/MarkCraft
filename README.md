# MarkCraft

MarkCraft 是一款用 **Rust 构建、免费开源**的 Windows 本地 Markdown 编辑器。打开 `.md` 文件就能在排好版的正文里写作。改表格时直接点单元格，改公式时点公式，想看整篇 Markdown 时按 `Ctrl + /`。文稿以普通文本保存在自己的电脑上。

**[下载 Windows x64 便携版](https://github.com/Hydralune/MarkCraft/releases/latest)** · [打开示例文稿](examples/城市雨量观测手记.md) · [使用指南](ui/guide.md) · [MIT 许可证](LICENSE)

![MarkCraft 默认浅色主题中打开城市雨量观测手记，左侧是章节大纲，正文包含可编辑表格和雨量曲线](docs/images/editor.png)

## 开始使用

1. 在发行页下载 `MarkCraft-v0.2.0-windows-x64.zip`，将**整个文件夹**解压到希望长期使用的位置。
2. 双击 `MarkCraft.exe`。按 `Ctrl + O` 打开自己的文稿，或打开包内的 `examples/城市雨量观测手记.md` 体验上图中的排版。
3. 如果希望双击 Markdown 文件就用 MarkCraft 打开，在解压目录的 PowerShell 里运行下面的命令，再到资源管理器的「打开方式」中选择 MarkCraft 并设为默认。注册只对当前 Windows 用户生效，也会提供 Markdown 文档图标。

```powershell
.\register-markdown.ps1 -Executable (Resolve-Path .\MarkCraft.exe)
```

桌面版使用系统的 Microsoft Edge WebView2。若启动时提示缺少运行时，可安装微软提供的 Evergreen Runtime。移动便携目录后，再运行一次上面的注册命令即可更新路径。[微软 WebView2 下载页](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

## 写作与整理

| 在文稿中 | 可直接完成的操作 |
| --- | --- |
| 写正文 | 编辑标题、引用、嵌套列表、任务清单和脚注。左下角「源码」可切换到带高亮的 Markdown 源文。 |
| 改表格 | 点击文字位置开始输入，用 Tab 切换单元格。拖动表头上边缘可移动整列，拖动正文行首格左边缘可移动整行。右键可插入、删除或调整对齐。 |
| 写代码与公式 | 在代码块中选择语言并查看语法高亮。点公式编辑 LaTeX，块公式会随输入预览。Mermaid 代码块可直接显示流程图。 |
| 管理图片 | 点图片可改说明、替换文件、编辑路径或移除引用。「收集本文图片」可将图片集中到文稿旁的资源目录。 |
| 浏览长文 | 大纲可折叠、筛选并跟随当前位置。`Ctrl + P` 按文件名打开文稿，`Ctrl + Shift + F` 搜索当前文件夹及子目录的正文。 |
| 保存与协作 | 默认自动保存。未命名文稿进入本地草稿箱。其他编辑器或 AI 改动磁盘文件时，未修改的窗口会同步。两边都有修改时，可选「保留两版」。 |
| 排版与导出 | 默认主题「澄明浅色」支持章节编号和 `[TOC]`。可切换深色或编辑主题 CSS。可直接导出带可选中文字的 PDF 和独立 HTML。 |

![同一份文稿中的行内公式、块公式、Rust 代码高亮与 Mermaid 流程图](docs/images/math-code.png)

按 `Ctrl + ,` 打开设置，可调整字号、正文宽度、自动保存、图片路径及 PDF 纸张和页边距。需要导出 Word、EPUB、ODT、RTF 或 LaTeX 时，可将 Pandoc 加入 `PATH`，或放在程序旁的 `tools/pandoc/pandoc.exe`。Pandoc 单独安装。

## 体积与实测内存

v0.2.0 的 Windows x64 便携包为 **3.21 MiB**，包含程序、加载器、使用指南、示例和许可证。主程序为 **8.07 MiB**。MarkCraft 复用系统 WebView2。Rust 负责窗口、文件读写、Markdown 解析、公式转换与导出，CodeMirror 6 负责文本编辑和输入法。

| 单窗口打开的文稿 | 整个进程树的专用工作集，中位数 | 五次实测范围 | 其中 Rust 主进程，中位数 |
| --- | ---: | ---: | ---: |
| 普通中文笔记，129 字节，含三项列表 | 91.4 MiB | 90.4–91.7 MiB | 4.5 MiB |
| 《城市雨量观测手记》，5,290 字节，附一张本地图、48 条明细、代码、公式和流程图 | 99.8 MiB | 97.6–103.9 MiB | 4.5 MiB |

测于 Windows 11 x64（系统构建 22621）、WebView2 158.0.4370.33。两份文稿分别使用新配置启动，定位到首页，确认内容载入后静置 10 秒，每隔约 2 秒取样，共 5 次。通过 Windows 性能计数器读取 `WorkingSetPrivate`，合计 MarkCraft 和它启动的 WebView2 子进程，每次共 7 个进程。表中数值反映这台机器的首页静置状态。滚动到更多图表、加载大图片或打开多个窗口时，占用会变化。

## 从源码构建

在 Windows 上安装支持 Rust 2024 edition 的稳定版工具链和相应的 C++ 链接工具。仓库已包含构建好的编辑器脚本，可用以下命令编译桌面程序并运行测试。

```powershell
.\build-windows.ps1
cargo test --release --locked
```

脚本会输出可执行文件路径。使用 x64 GNU 工具链时，它还会复制匹配的 `WebView2Loader.dll`。修改 `ui/writer.js` 或其导入的编辑器模块后，先重建前端资源，再运行 Rust 构建脚本。

```powershell
cd ui
npm ci
npm run build
cd ..
.\build-windows.ps1
```

主题源文件位于 `themes/`。在程序的「主题」菜单打开主题目录，可编辑当前用户使用的 CSS，再从菜单重新载入。

## 开源许可

MarkCraft 采用 MIT 许可证，允许免费使用、修改和分发。编辑器使用 CodeMirror 6、pulldown-cmark、highlight.js、Mermaid 和 latex2mathml 等组件。Claudette 亮暗主题改编自 CookPiu 的作品。第三方组件保留各自的许可和署名，便携包的 `licenses/` 目录提供对应文本。[项目许可证](LICENSE) · [编辑器及渲染组件许可](vendor/) · [Claudette 主题许可](themes/Claudette-LICENSE.txt)
