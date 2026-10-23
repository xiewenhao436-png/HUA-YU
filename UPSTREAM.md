# 来源、派生关系与致谢

画屿基于 [Xiangyu-CAS/codex-canvas](https://github.com/Xiangyu-CAS/codex-canvas) 二次开发，并非仅参考界面灵感。

- 原项目版本基线：v0.4.0。
- 原源码基线提交：[9bccd0f95f0c2bafd355084f382f8a584bd13320](https://github.com/Xiangyu-CAS/codex-canvas/commit/9bccd0f95f0c2bafd355084f382f8a584bd13320)。
- 原项目许可证：[MIT](LICENSE)，原版权声明保留。
- 本项目独立维护仓库：<https://github.com/xiewenhao436-png/HUA-YU>。

保留的基础包括无限画布、MCP 集成、图像操作、后台任务与资产存储等。画屿的主要增量见 [CHANGELOG.md](CHANGELOG.md)。部分内部文件名、环境变量和旧 URI 保留原标识，以便读取已有画布并协调新旧插件的操作锁。

原项目 README 对 [Cowart](https://github.com/zhongerxin/Cowart) 的致谢亦在此保留。画布中心的整理思路参考 [AFFiNE Design](https://github.com/toeverything/design) 与 [Actual Design Guidelines](https://github.com/actualbudget/actual/blob/master/DESIGN.md)，没有引入它们的组件代码。

界面使用 Lucide 图标；其 ISC 及 Feather 衍生图标 MIT 许可见 `assets/lucide-license.txt`。打包依赖的完整许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 `LICENSES/`。

项目示例截图使用合成测试图形，不包含真实客户画面、个人会话或密钥。画屿不是 OpenAI 或原项目的官方发行版。
