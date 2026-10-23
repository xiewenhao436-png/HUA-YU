# 第三方许可

画屿的派生关系及原作者版权见 [UPSTREAM.md](UPSTREAM.md) 与 [LICENSE](LICENSE)。以下清单由已安装的运行依赖及界面实际打包输入生成。完整 LICENSE / NOTICE 原文保存在 `LICENSES/`，它们各自的许可条款保持有效。

MCP Apps SDK 的本次分发许可证包含 MIT 向 Apache-2.0 过渡的说明；此处保留完整原文，不以 package.json 中的单个 license 字段替代。Zod 等组件亦保留其完整许可。

| 组件 | 版本 | 许可原文 |
| --- | --- | --- |
| @modelcontextprotocol/ext-apps | 1.7.5 | [原始许可与 NOTICE](LICENSES/modelcontextprotocol--ext-apps.txt) |
| @modelcontextprotocol/sdk | 1.32.1 | [原始许可与 NOTICE](LICENSES/modelcontextprotocol--sdk.txt) |
| ag-psd | 31.0.0 | [原始许可与 NOTICE](LICENSES/ag-psd.txt) |
| base64-js | 1.5.1 | [原始许可与 NOTICE](LICENSES/base64-js.txt) |
| cross-spawn | 7.0.6 | [原始许可与 NOTICE](LICENSES/cross-spawn.txt) |
| isexe | 2.0.0 | [原始许可与 NOTICE](LICENSES/isexe.txt) |
| pako | 2.1.0 | [原始许可与 NOTICE](LICENSES/pako.txt) |
| path-key | 3.1.1 | [原始许可与 NOTICE](LICENSES/path-key.txt) |
| pngjs | 7.0.0 | [原始许可与 NOTICE](LICENSES/pngjs.txt) |
| shebang-command | 2.0.0 | [原始许可与 NOTICE](LICENSES/shebang-command.txt) |
| shebang-regex | 3.0.0 | [原始许可与 NOTICE](LICENSES/shebang-regex.txt) |
| which | 2.0.2 | [原始许可与 NOTICE](LICENSES/which.txt) |
| zod-to-json-schema | 3.25.2 | [原始许可与 NOTICE](LICENSES/zod-to-json-schema.txt) |
| zod | 4.6.7 | [原始许可与 NOTICE](LICENSES/zod.txt) |

界面内联图标来自 Lucide，包含 Feather 衍生图标，完整 ISC / MIT 许可见 [Lucide](LICENSES/lucide.txt)。

重新构建前运行 `node scripts/collect-licenses.mjs` 可更新清单；使用 `--check` 验证已提交的清单是否与当前锁定依赖及实际打包输入一致。
