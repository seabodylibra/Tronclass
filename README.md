# USST 一网畅学课件下载助手

这是一个面向上海理工大学一网畅学（TronClass，`https://1906.usst.edu.cn/`）的浏览器用户脚本。它在课程学习活动/课件详情页显示悬浮面板，读取当前活动的附件列表，并使用当前浏览器已经登录的一网畅学 session 获取下载地址。

## 功能

- 自动识别当前课程活动 ID，并适配 TronClass 的 SPA 页面切换。
- 显示活动 ID、附件数量、附件名称、下载状态和错误信息。
- 支持一个活动中的多个附件。
- 优先请求原始文件，支持 PPT、PPTX、PDF、DOC、DOCX 等常见课件。
- 原文件地址不可用时，尝试平台提供的预览地址。
- 预览接口返回 PDF 时，Office 文件会按 `.pdf` 文件名保存。
- 提供“刷新附件”“下载当前课件”“下载全部附件”按钮。
- 多个附件按顺序下载，并在文件之间留出短暂间隔。
- 不 hook 或重写全局 `fetch` / `XMLHttpRequest`，不读取 Cookie，不上传数据，不包含统计或第三方追踪。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 从 Greasy Fork 安装脚本：待发布。
3. 或直接安装 GitHub 仓库中的 `usst-tronclass-downloader.user.js`。
4. 登录一网畅学。
5. 进入课程的学习活动/课件详情页。
6. 使用页面右侧的悬浮下载面板。

GitHub 仓库：[seabodylibra/Tronclass](https://github.com/seabodylibra/Tronclass)。当前目录没有原始脚本，因此本版本按 clean-room 方式重新实现，没有复制其他作者的代码。

## 使用范围与隐私

本脚本仅用于下载用户本人已经具有正常访问权限的课程资源。

脚本不会：

- 读取、导出或保存 Cookie、密码或登录凭据；
- 绕过账号权限或尝试访问无权访问的课程；
- 上传课程、用户或其他个人数据；
- 添加统计、遥测、广告或第三方追踪；
- 使用远程执行代码、混淆代码或修改平台全局网络 API。

脚本只会向当前站点的明确接口发起带 `credentials: "include"` 的 GET 请求，并将平台返回的文件地址交给浏览器下载。

## API 行为说明

脚本当前使用以下接口：

```text
GET /api/activities/<activityId>/upload_references
GET /api/uploads/reference/document/<referenceId>/url
GET /api/uploads/reference/document/<referenceId>/url?preview=true
```

TronClass 不同版本的字段可能略有差异。脚本优先解析常见的 `references`、`id`、`name`、`file_name` 等字段；如果返回结构变化，面板会显示错误，并将不包含文件内容的调试信息写入浏览器控制台。

预览接口如果仍处于生成中、返回空地址、返回 HTML 在线查看器而不是 PDF，脚本无法在浏览器端可靠地把在线查看器转换成 PDF；此时会显示失败原因，不会静默伪造文件。

## 故障排查

- **提示未识别活动 ID**：确认当前地址是课程学习活动/课件详情页，并点击“刷新附件”。
- **401**：重新登录一网畅学。
- **403**：当前账号或当前活动没有访问权限。
- **404**：活动、附件或 reference ID 可能已经失效。
- **500**：平台服务暂时异常，请稍后重试。
- **下载被浏览器拦截**：允许 `1906.usst.edu.cn` 连续下载，或在用户脚本管理器中允许下载权限。
- **原文件失败但预览也失败**：检查平台是否仍在生成预览，稍后点击“刷新附件”重试。

详细错误会输出到浏览器开发者工具的 `console.warn` / `console.error`，不会输出 Cookie 或文件内容。

## 兼容性

目标兼容 Tampermonkey、Violentmonkey、Chrome/Chromium 和 Microsoft Edge。脚本只匹配 `https://1906.usst.edu.cn/course/*`。

## 许可证

本项目使用 MIT License，见 [LICENSE](LICENSE)。

