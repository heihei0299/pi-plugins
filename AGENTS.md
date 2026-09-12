## 路由
命中即执行，并简短声明使用的 skill / 工具。
* 理解 / 定位 / 调用链 → `codegraph explore`
* 外部调研 / 方案比较 → `research`
* 原型 / PoC → `prototype`
* 简单修改 → 直接实现
* TDD / 集成测试 → `tdd`
* 代码审查 → `code-review`
* 设计质询 → `grilling`
* 领域建模 → `domain-modeling`
* 无法归类 → `ask-matt`
\仅当关键歧义会改变结果时询问用户。
## CodeGraph
仓库内代码理解首先使用：
```bash
codegraph explore "<问题>"
```
无 `.codegraph/` 时：
```bash
codegraph init
codegraph explore "<问题>"
```
* 从最小必要上下文开始；返回完整源码即视为已读。
* 信息不足时只针对缺口继续 `explore`；已锁定符号时使用 `codegraph node`。
* CodeGraph 无法提供必要信息时，才降级到最小必要的读取 / 搜索。
* `research` 只用于仓库外信息。
## 执行
默认闭环：
```text
定位 → 实现 → 验证 → 修正
```
* 以仓库当前代码、类型、配置、测试和版本化文档为事实来源。
* 优先复用现有抽象、接口和依赖方向。
* 不创建平行实现，不扩大任务范围。
* 简单任务直接执行；复杂任务需要时形成最小可执行计划。
* 仅在需要用户判断或授权时中断闭环。
## 验证
服从全局授权规则。
* 已授权时执行能证明本次改动正确的最小验证。
* bug 验证原复现路径；性能问题使用可测量指标。
* 根据验证反馈修正，不重复等价检查或自动增加 review / CI。
## Harness
同类问题反复出现时，优先将约束落实到测试、lint、类型、工具或代码结构，而不是继续扩充本文件。
## Git
有实际改动且满足全局规则时，每个用户请求最多一次 commit。
* 提交前检查 diff。
* 只 stage 本次任务文件。
* 不使用 `git add .` / `git add -A`。

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context domain docs use root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
