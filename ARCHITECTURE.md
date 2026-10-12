# Tabloom 结构与约束

这是围绕“AI 主题分类 + 固定工作空间”重新实现的 Manifest V3 扩展。界面与业务逻辑使用原生 ES 模块，无构建步骤，无运行时第三方依赖。

## 模块职责

| 路径 | 职责 |
| --- | --- |
| `src/core/config.js` | 产品常量、默认配置、存储键和颜色 |
| `src/core/validation.js` | 接口、用户配置、网址与固定组验证 |
| `src/core/plan.js` | 模型分组结果验证及标签快照核对 |
| `src/core/model.js` | Chat Completions 请求、响应转换与用量解析 |
| `src/core/search.js` | 新标签页搜索引擎与安全网址导航 |
| `src/background/repository.js` | 本地数据、会话状态、用量统计、迁移和写入串行化 |
| `src/background/workspace.js` | 按窗口执行分析、固定、恢复和批量操作 |
| `src/background/main.js` | 事件监听、调度与消息分发 |
| `src/background/newtab-router.js` | 按开关接管 Chrome / Edge 原生新标签页 |
| `src/ui/client.js` | 页面与后台之间的消息协议、反馈和按钮状态 |
| `src/ui/app.js` | 管理中心的路由、表单和视图 |
| `src/ui/popup.js` | 弹窗快捷入口 |
| `src/ui/newtab.js` / `newtab.css` | 独立新标签页、搜索、固定组入口及开关恢复 |
| `src/ui/theme.css` | 统一视觉样式和响应式布局 |
| `assets/` | 新图标原图及 Chrome 所需尺寸 |

## 分析流程

标签事件通过持久化的 Chrome alarms 合并调度，默认等待 20 秒（可设置 5–300 秒），每次未分组页面打开、跳转或加载完成都会重新计时。关闭标签不新增或推迟任务。请求前查询仍存在的页面，无待整理标签时不发起模型请求。自动整理默认关闭，用户主动开启后才请求所配置的服务。浏览器休眠可能延后触发。

自动分析只提交未分组、未固定、HTTP/HTTPS 的页面，手动分析也会重新整理当前会话内的 AI 托管组；手动和固定组始终排除。每批最多 60 个页面，附带每个已有 AI 组最多两个代表页面，帮助按共同用途抽象分类。AI 对话默认归为 Chat，不按品牌拆分。标题截取 300 字符；默认去除网址查询参数，始终去除网址片段。模型必须完整且唯一地分配每批标签。任何格式、遗漏、重复或未知 ID 都会阻止该批次应用。

分组前重新查询标签，核对 URL、固定状态和分析前的分组 ID。被关闭、跳转或手动分组的标签跳过。已经成功应用的批次不会因后续批次失败而撤销；操作状态显示失败信息。

只复用当前会话内标记为 AI 托管的浏览器组。用户修改组名后不会再根据旧名称追加；保存为固定组时解除 AI 托管。固定组恢复时创建新的标签和浏览器组，失败则只回滚本次创建的标签。

## 并发与持久化

- 每个窗口独立处理任务。同一窗口的重复分析复用正在运行的任务；手动操作取消之前的任务，等待它结束后执行。
- 网络调用使用 AbortController 和 25 秒超时。停止操作和解散分组可取消在途分析。
- 固定组写入由后台的单一 Repository 串行化，避免两个管理页面同时修改时覆盖其他记录。
- `storage.local` 保存 `tabloom.preferences`、`tabloom.library`、`tabloom.usage` 和迁移标记；`storage.session` 保存窗口运行状态及 AI 托管组 ID。
- `tabloom.usage` 在每次发起模型请求时累加请求数；只有响应含可识别的 Token 用量字段时才累加 Token。失败请求仍计入请求数，缺少用量字段的响应不推算 Token。
- Service worker 重启后，界面将未运行的遗留忙碌状态显示为已结束，用户可以重新整理。
- 首次启动迁移之前版本的 `modelSettings` 和 `savedGroups`；旧数据原样保留，新代码不再写入旧键。

## 验证

`npm test` 检查核心验证、请求、迁移、写入并发、取消、分批处理和固定组回滚；`npm run check` 检查模块语法和资源引用。`scripts/browser-check.js` 使用隔离 Chromium 扩展环境及本地模拟模型服务验证完整操作流程，截图输出至忽略的 `artifacts/` 目录。

## 新标签页

独立的 `tabloom.appearance` 保存开关和搜索引擎，无需完整模型配置；新标签页只请求显示配置与固定组，不获取模型密钥或调用模型。

后台监听标签创建与更新，识别 Chrome / Edge 原生新标签页。仅当开关开启时，重新核对标签当前网址及设置，再导航到本地 `newtab.html`。相同标签的重复事件合并；若用户已经输入其他网址，不覆盖正在进行的导航。

关闭时不执行导航，保留浏览器原本的新标签页及其配置。没有清单层面的静态 newtab 覆盖，也不使用硬编码的默认内部页跳转。直接打开 `newtab.html#preview` 可独立预览。Edge 的 MSN 新标签页也识别为原生页，并排除在 AI 分析候选之外。

`scripts/edge-check.js` 在隔离的真实 Microsoft Edge 配置中验证开关行为，`scripts/browser-check.js` 验证 Chromium 的完整操作流程。
