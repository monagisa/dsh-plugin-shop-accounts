# tools/

仓库自带的发布与校验脚本。全部从仓库内运行，不依赖仓库外的任何路径，也不写死 Node 的安装位置（用当前 `node` 可执行文件）。

| 脚本 | 作用 | npm 命令 |
| --- | --- | --- |
| `rebuild-readme-blocks.mjs` | 重建 README 的「自检」代码块与合计项数（套件清单在脚本的 `SUITES` 里维护） | `npm run readme` |
| `check-readme.mjs` | 检查 README 的目录锚点、代码围栏、表格列数 | `npm run doctor` |
| `scan-colloquial.mjs` | 扫描 README 里的口语化表达与第二人称 | `npm run doctor` |
| `verify-clean.mjs` | 扫描不该出现的内容（上游产品名、与上游实现细节相关的词、本机路径、真实店名与人名、账号 ID、邮箱） | `npm run doctor` |
| `check-syntax.mjs` | 对 `lib/`、`test/`、`tools/` 下所有 `.js` / `.mjs` 跑一遍 `node --check` | `npm run check` |
| `run-suites.mjs` | 依次跑全部自检套件并汇总项数，结果写到 `suite-result.txt` | `npm run suites` |
| `bump-version.mjs` | 升版的机械动作：版本号、描述、CHANGELOG 段头、README 版本行、重建自检块（版本特有的正文仍需人工补） | 直接执行 |
| `migrate-collect-naming.mjs` | 把已有采集数据整理成新命名（作业目录带时间、产物带配方前缀、补 manifest、按上限清理），`--dry` 只打印 |

## 升版流程

```powershell
node tools/bump-version.mjs 0.20.0 "；v0.20.0 起 ……"
# 按脚本打印的待办补 CHANGELOG 正文、README 更新说明小节、SUITES 清单
npm run readme
npm run check
npm run suites
npm run doctor
```

`run-suites.mjs` 默认以仓库根目录为工作目录，也接受一个参数指定其它目录（用于验证安装副本）：

```powershell
node tools/run-suites.mjs C:\Users\<用户名>\.dsh\profiles\desktop\node_modules\dsh-plugin-shop-accounts
```

## 维护约定

- 新增自检套件时，同时更新 `package.json` 的 `test` 链与 `tools/rebuild-readme-blocks.mjs` 的 `SUITES`，再跑 `npm run readme`。
- `verify-clean.mjs` 的规则表里写着待查词，因此扫描时跳过 `tools/scan-colloquial.mjs` 与 `tools/verify-clean.mjs` 这两个文件本身。
- 文档与代码一律使用 LF 换行、UTF-8 编码（见仓库根的 `.editorconfig`）。
