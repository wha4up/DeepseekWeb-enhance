# DS Enhance

DeepSeek Chat (chat.deepseek.com) 的浏览器增强脚本，提供网页端缺失的批量管理功能。

## 功能

| 功能 | 说明 |
|------|------|
| **批量删除** | 勾选多个对话一键删除，支持清空全部 |
| **Fork 对话** | 完整复制对话，或从指定消息节点开始分支 |
| **会话分类** | 创建自定义标签，给对话打分类（数据存本地，支持导入/导出） |
| **搜索** | 按标题实时搜索对话历史 |
| **导出** | 导出对话为 JSON 或 Markdown 文件 |
| **批量重命名** | 直接重命名、添加前缀/后缀、查找替换、序号命名 |

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 点击 [ds-enhance.user.js](./ds-enhance.user.js) 查看脚本源码
3. 在 Tampermonkey 中新建脚本，粘贴源码并保存
4. 打开 [chat.deepseek.com](https://chat.deepseek.com)，页面左下角出现蓝色齿轮按钮即安装成功

**快捷键：** `Ctrl+Shift+D` 切换面板

## 截图

点击左下角悬浮按钮（可拖动），打开控制面板：

<img width="577" height="320" alt="图片" src="https://github.com/user-attachments/assets/74fdca45-4f57-46f7-9ef9-dde45568d691" />


## 技术原理

脚本通过注入浏览器 `fetch` 所需的 Bearer Token（从 `localStorage.userToken` 读取），直接调用 DeepSeek 的内部 API：

- `POST /api/v0/chat_session/delete` — 删除对话
- `POST /api/v0/chat_session/update_title` — 重命名
- `GET /api/v0/chat_session/fetch_page` — 获取对话列表
- `GET /api/v0/chat/history_messages` — 获取消息历史
- `POST /api/v0/share/create` + `POST /api/v0/share/fork` — Fork 对话

分类数据存储在浏览器 `localStorage` 中，可通过脚本内导入/导出功能备份。

## 项目结构

```
ds-enhance/
├── ds-enhance.user.js   # 油猴脚本（全部逻辑，~900 行）
├── README.md
├── LICENSE
└── CHANGELOG.md
```

## 为什么只有一个文件？

这是一个 [UserScript](https://en.wikipedia.org/wiki/Userscript)，通过 Tampermonkey 注入到网页中运行。它不需要构建流程、不需要 npm 依赖——一个文件即可完成所有功能。这是 UserScript 生态的标准实践。

## 开发

直接编辑 `ds-enhance.user.js`，在 Tampermonkey 中刷新脚本后刷新网页即可测试。

## TODO

- [ ] Fork 选择起点时增加助手回复预览
- [ ] 搜索支持日期范围过滤
- [ ] 导出 Markdown 支持树形分支结构
- [ ] 批量操作失败重试机制

## License

[GPL-3.0](./LICENSE)
