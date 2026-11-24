# Unsliced Core（分页核心）

**Unsliced 家族 / Unsliced family:** [Core](https://github.com/harrythex42/unsliced-core) · [MCP](https://github.com/harrythex42/unsliced-mcp) · [Web](https://github.com/harrythex42/unsliced-web)

[English](README.md) · 中文

Core 是 Unsliced 共用的分页程序。它比较整份文档的分页方案，让标题跟着后面的内容走；长表只在完整的行之间分页，续页重复表头。PDF 文字可以搜索、复制。

要把 Markdown 或 HTML 排成 PDF，请使用 [MCP 版](https://github.com/harrythex42/unsliced-mcp)或[网页版](https://harrythex42.github.io/unsliced-web/)。这里保留分页源码、浏览器和 Node 接口、命令行工具、HTML 样例和实验记录。

![固定高度切片切开一行表格；Unsliced 保留了整行](docs/images/hero-slices-zh.png)

## 使用分页程序

在 [Core 发布页](https://github.com/harrythex42/unsliced-core/releases)选一个明确的版本，不用「最新版」链接。下载 `unsliced-engine.tar.gz` 和 `unsliced-engine.tar.gz.sha256`。在下载目录运行 `shasum -a 256 -c unsliced-engine.tar.gz.sha256`，确认校验通过再用 `tar -xzf unsliced-engine.tar.gz` 解压。

- 浏览器加载 `engine/runtime/index.global.js`，使用 [`BreakFlow` 接口](packages/browser/README.md)。
- Node 使用 `engine/runtime/index.mjs` 导出的 `generatePdf` 和 `DEFAULT_OPTIMAL_OPTIONS`。安装清单中指定版本的 `playwright` 和对应的 Chromium；保留浏览器文件和 `engine/assets/fonts/` 原有位置。详见 [Playwright 接口](packages/playwright/README.md)。

两个产品各自记录使用的版本、完整源码版本号和压缩包的校验值，互相不依赖。升级时先核对压缩包，再核对 `engine/manifest.json` 里的源码版本号和每个文件的校验值，最后跑自己的验收。

## 本地验收与打包

准备 Node.js 22 或更新版本、pnpm 和 Python 3，然后运行：

```sh
pnpm install --frozen-lockfile
python3 -m pip install -r scripts/requirements.txt
pnpm exec playwright install chromium
pnpm acceptance
```

34 项验收的报告、PDF 和逐页图片都在 `output/acceptance/`。报告对比两种分页方法的页数、留白、意外切块和落在页底的标题。

验收通过后，从没有未提交修改的目录运行 `pnpm engine:pack`。把 `output/engine-release/` 里的压缩包和校验文件上传到 GitHub 的新版本，版本标签必须对准清单中记录的源码版本。不要替换已发布版本的文件。

[结构说明](docs/architecture.md) · [分页规则](docs/optimal-pagination.md) · [表格](docs/tables.md) · [效果对比](docs/comparison/README.md) · [实验记录](experiments/web-feasibility/README.md)

基于 [BreakFlow](https://github.com/mehmetduran932/BreakFlow)。保留 [MIT 授权](LICENSE)和[字体 OFL 授权](packages/playwright/assets/fonts/OFL.txt)。
