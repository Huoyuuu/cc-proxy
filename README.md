# cc-proxy

把 Command Code 转成一个本地 OpenAI 兼容接口，附带额度和调用记录面板。

需要 Node.js 24。先在 Command Code 或 pi 的 Command Code 插件中登录，
确保 `~/.commandcode/auth.json` 中有 `apiKey`。

```bash
node cc-proxy.mjs
```

打开 `http://127.0.0.1:19002` 查看面板。
客户端 Base URL 填 `http://127.0.0.1:19002/v1`，API Key 填 `sk-cc-local`。
这个 Key 是占位值；服务只监听本机，不校验客户端 Key。

模型：`deepseek-v4.1-flash`、`deepseek-v4.1-flash-fast`。
支持流式输出、工具调用、推理内容和 base64 图片。
改端口可设置环境变量 `CC_PROXY_PORT`。

调用记录存在启动目录的 `data/calls.db`，完整保留历史，不自动删除。
旧的 `data/calls.jsonl` 会在启动时导入，原文件保留，重复启动不会重复导入。
面板显示最近 200 条，累计统计和 24 小时图表读取全部记录。

Windows 可双击 `start_cc_proxy_hidden.vbs` 静默启动，需将 Node.js 加入 PATH。
用 `uv run test_api.py` 检查接口，会实际调用上游模型。
`data/`、`docs/`、`Temp/` 和登录凭据不上传到仓库。
