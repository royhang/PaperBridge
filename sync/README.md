# PaperBridge 云同步服务

零依赖 Node.js（18+）轻量多端同步服务，用于在网页版、Windows / macOS / Linux 桌面客户端之间用同一账号双向同步：

- 文献元数据、分类、标签、阅读进度与星标
- PDF 原文文件（按 SHA-256 去重秒传，且按账号做访问隔离）
- 高亮笔记、术语表、AI 对话、翻译缓存
- **端到端加密的 API 配置**（在客户端用账号密码派生的 AES-256-GCM 密钥加密后再上传，服务端不保存明文 API Key）

## 快速启动

```bash
node sync/server.mjs
curl http://127.0.0.1:8788/api/health
```

| 环境变量 | 说明 |
| --- | --- |
| `HOST` | 监听地址，默认 `127.0.0.1` |
| `PORT` | 监听端口，默认 `8788` |
| `SYNC_DATA_DIR` | 数据存储目录，默认 `./sync-data` |
| `ALLOW_REGISTER` | 是否允许新用户注册，默认 `1`；建完自己的账号后可设为 `0` 关闭注册 |
| `INVITE_CODE` | 可选注册邀请码；设置后注册时必须填写一致的邀请码 |
| `MAX_PDF_MB` | 单个 PDF 最大体积，默认 `150` MB |
| `MAX_SYNC_MB` | 单次同步合并 JSON 上限，默认 `64` MB |

## 反向代理（Caddy 示例）

如果已通过 Caddy 托管网页版与跨域代理，只需在同一个站点块里增加 `/api/*` 转发：

```caddy
@pbsync path /api/*
handle @pbsync {
    reverse_proxy 127.0.0.1:8788
}
```

然后在 PaperBridge 的「设置 → 云同步」填入该 HTTPS 地址，注册或登录同一账号即可在多端自动共享。
