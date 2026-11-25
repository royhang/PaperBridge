# CORS 代理

需要 Node.js 18 或更新版本，无需安装依赖。请求体上限为 10 MB，支持流式 SSE 响应。在项目根目录运行以下命令启动并检查服务。

```sh
node proxy/server.mjs
curl http://127.0.0.1:8787/health
```

在应用设置的「代理地址」中填入 `http://127.0.0.1:8787`，并为需要代理的服务启用代理（`useProxy`）。应用会自动拼接 `/proxy?url=<编码后的目标 URL>`。远程部署时填写 HTTPS 代理的根地址。

| 环境变量 | 说明 |
| --- | --- |
| `HOST` | Node 监听地址，默认 `127.0.0.1` |
| `PORT` | Node 监听端口，默认 `8787` |
| `ALLOWED_HOSTS` | 逗号分隔的域名或域名后缀，默认放行常用翻译和 LLM API。配置值会替换默认列表，`*` 放行任意域名 |
| `ALLOW_ANY_GET` | 设为 `1` 后，`GET` 和 `HEAD` 也可访问允许列表以外的公网 HTTP(S) 地址，默认关闭。其他方法仍需匹配 `ALLOWED_HOSTS` |
| `MAX_DOWNLOAD_MB` | 开放下载的响应大小上限，默认 100 MB（每 MB 为 1024² 字节），支持正小数 |
| `ALLOW_PRIVATE` | 设为 `1` 跳过私有地址检查，默认关闭，仅供本地开发 |
| `PROXY_TOKEN` | 可选共享密钥。启用后，将同一密钥填入应用的代理密钥设置（`proxyToken`），应用会发送 `x-proxy-token` |

## 文献库导入

导入期刊站点、arXiv、Crossref、Unpaywall 和机构知识库的 PDF 或元数据时，将 `ALLOWED_HOSTS` 设为使用的 LLM API 域名，将 `PROXY_TOKEN` 设为随机密钥，并保持 `ALLOW_PRIVATE` 关闭。例如：

```sh
ALLOWED_HOSTS=api.openai.com,api.anthropic.com ALLOW_ANY_GET=1 PROXY_TOKEN='替换为随机密钥' node proxy/server.mjs
```

Node 代理对每次上游连接检查 IP 字面量或 DNS 返回的全部地址。只要有一个地址属于回环、私有、链路本地、运营商共享、组播、广播、保留或文档网段，就会拒绝请求。检查也涵盖 IPv4 映射的 IPv6 和 `198.18.0.0/15` 基准测试网段。通过检查后，HTTP 客户端直接连接选定的 IP，保留原域名用于 `Host`、TLS SNI 和证书校验，避免再次解析造成 DNS 重绑定。

开放下载最多跟随 5 次重定向，每一跳都重新校验协议和目标地址。开放下载的全部请求都会移除 `Authorization`、`x-api-key` 和 `Cookie`。匹配允许列表的 API 请求仍会原样返回上游重定向状态，并保留 API 认证头。配置了 `PROXY_TOKEN` 时，所有 `/proxy` 转发都需要密钥。

Node 开放下载的上游空闲超时为 60 秒。响应声明的长度超过上限时立即返回 `413`。长度未知或需要解压的响应会先写入临时文件，边接收边检查大小，超限时取消下载并返回 `502` JSON。其余响应直接流式转发。浏览器可直接访问已启用 CORS 的本机 Ollama。

## Docker

在项目根目录使用以下 Dockerfile，启动容器时可用 `-p 127.0.0.1:8787:8787` 仅映射本机端口。

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY proxy/server.mjs proxy/worker.js ./proxy/
COPY package.json ./
ENV HOST=0.0.0.0
EXPOSE 8787
USER node
CMD ["node", "proxy/server.mjs"]
```

## Cloudflare Workers

1. 在 Cloudflare 控制台创建 Worker，将 `proxy/worker.js` 作为 ES module 入口部署。启用 `enable_request_signal` 兼容性标志，以便客户端断开时取消上游请求。
2. 在 Worker 的 Variables and Secrets 中配置 `ALLOWED_HOSTS`，按需启用 `ALLOW_ANY_GET=1` 和设置 `MAX_DOWNLOAD_MB`，并将 `PROXY_TOKEN` 添加为 Secret。Worker 校验 IP 字面量，每一跳的 DNS 和连接由 Cloudflare 管理。已开始转发的响应超限时，Worker 会中断流。保存部署后，用 `https://<worker>.workers.dev/health` 检查服务。
3. 将 Worker 的 HTTPS 根地址填入应用的「代理地址」。

本地冒烟测试运行 `node --test proxy/test.mjs`。
