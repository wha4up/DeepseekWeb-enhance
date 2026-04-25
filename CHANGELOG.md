# Changelog

## [3.0.0-mcp] - 2025-04-25

### Added
- 控制面板：绿色悬浮球（可拖动），点击或 Ctrl+Shift+M 打开
- 状态 Tab：连接状态、已注册工具列表
- 测试 Tab：选择工具 → 动态生成参数表单 → 执行 → 查看结果
- 设置 Tab：MCP 服务器地址配置
- 未连接时悬浮球变红，连接成功变绿

## [2.0.0-mcp] - 2025-04-25

### Added
- DeepSeek 原生 SSE 格式解析（`p`/`v` 字段），兼容 OpenAI 格式
- Flex match 工具调用检测：支持 SSE token 边界截断情况下的模糊匹配
- 工具结果自动注入：执行结果通过聊天输入框发回给 DeepSeek
- `<tool_result>` 标签系统提示，引导 AI 理解工具结果并继续回答
- 发送按钮 fallback：Enter 键模拟失败时自动点击发送按钮
- 面板显示版本号

### Changed
- XHR hook + fetch hook 双重拦截，覆盖 DeepSeek 全部请求方式
- 合并「连接服务器」和「刷新工具列表」为单一按钮
- 清理 debug 日志，console 只保留关键信息

## [1.0.0-mcp] - 2025-04-25

### Added
- **DS MCP Bridge** — 全新油猴脚本，让 DeepSeek Chat 调用本地 MCP 工具
- SSE 拦截器：hook `window.fetch`，实时解析 DeepSeek 流式响应
- MCP 客户端：通过 `GM_xmlhttpRequest` 绕 CORS 调用本地服务器
- 工具调用检测：解析 AI 输出中的 `` ```mcp:tool_name`` `` 格式
- MCP 服务器端 (Python/FastAPI)：JSON-RPC 2.0 协议，支持 7 个内置工具
  - `execute_command`, `get_cwd`, `list_directory`, `read_file`, `write_file`
  - `bing_search`, `crawl_webpage`
- 控制面板：MCP 状态、调用历史、设置（服务器地址、自动执行开关）
- 共享基础设施提取至 `shared/shared-header.js`

## [3.0.0] - 2025-04-25

### Added
- 会话分类：创建自定义标签，给对话打分类，按分类筛选，支持导入/导出分类数据
- 搜索：按标题实时搜索对话，支持高亮匹配关键词
- 导出：导出对话为 JSON 或 Markdown 文件
- 批量重命名：直接重命名、添加前缀/后缀、查找替换、序号命名
- 悬浮球支持拖动定位
- Tab 栏横向可滚动

### Fixed
- URL 匹配：适配 DeepSeek 实际路由 `/a/chat/s/{uuid}`

## [2.0.0] - 2025-04-25

### Added
- 悬浮控制面板（不依赖页面 DOM 结构）
- 批量删除对话（勾选删除、清空全部，带进度条）
- Fork 对话（完整复制、从指定节点分支）
- 右键菜单 Fork / 删除
- 快捷键 Ctrl+Shift+D

## [1.0.0] - 2025-04-25

### Added
- 初始版本
- 尝试注入侧边栏按钮（因 DOM class 动态哈希，v2 中放弃此方案）
