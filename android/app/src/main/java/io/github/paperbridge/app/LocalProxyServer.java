package io.github.paperbridge.app;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Zero-dependency loopback CORS proxy (127.0.0.1:<random port>) for the Android APK.
 * Uses Android's native HttpURLConnection stack so LLM / MT APIs (DeepL, Baidu, Youdao,
 * OpenAI, DeepSeek, Claude, Gemini, campus endpoints) and arXiv/DOI PDF downloads work
 * out-of-the-box with zero CORS errors and automatically respect the device's VPN / Clash.
 */
public final class LocalProxyServer {
    private static final int MAX_BODY_BYTES = 16 * 1024 * 1024;
    private static final Set<String> HOP_HEADERS = new HashSet<>();
    private static final Set<String> STRIP_REQ_HEADERS = new HashSet<>();

    static {
        String[] hop = {
            "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"
        };
        for (String h : hop) HOP_HEADERS.add(h);

        String[] stripReq = {
            "origin", "referer", "x-proxy-token", "cookie",
            "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest",
            "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "accept-encoding"
        };
        for (String h : stripReq) STRIP_REQ_HEADERS.add(h);
    }

    private final String token;
    private ServerSocket serverSocket;
    private ExecutorService pool;
    private volatile boolean running;

    public LocalProxyServer() {
        byte[] buf = new byte[24];
        new SecureRandom().nextBytes(buf);
        StringBuilder sb = new StringBuilder(48);
        for (byte b : buf) sb.append(String.format(Locale.US, "%02x", b));
        this.token = sb.toString();
    }

    public String getToken() {
        return token;
    }

    public String getBaseUrl() {
        if (serverSocket == null) return "";
        return "http://127.0.0.1:" + serverSocket.getLocalPort();
    }

    public synchronized void start() throws IOException {
        if (running) return;
        serverSocket = new ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"));
        running = true;
        pool = Executors.newCachedThreadPool();
        pool.execute(() -> {
            while (running) {
                try {
                    Socket client = serverSocket.accept();
                    pool.execute(() -> handleClient(client));
                } catch (IOException ignored) {
                    if (!running) break;
                }
            }
        });
    }

    public synchronized void stop() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
            serverSocket = null;
        }
        if (pool != null) {
            pool.shutdownNow();
            pool = null;
        }
    }

    private void handleClient(Socket socket) {
        try (Socket s = socket) {
            s.setTcpNoDelay(true);
            s.setSoTimeout(120_000);
            BufferedInputStream in = new BufferedInputStream(s.getInputStream(), 16384);
            OutputStream out = s.getOutputStream();

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0].toUpperCase(Locale.US);
            String rawPath = parts[1];

            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int idx = line.indexOf(':');
                if (idx > 0) {
                    String k = line.substring(0, idx).trim().toLowerCase(Locale.US);
                    String v = line.substring(idx + 1).trim();
                    headers.put(k, v);
                }
            }

            String origin = headers.getOrDefault("origin", "*");
            String corsBlock = buildCorsHeaders(origin);

            if ("OPTIONS".equals(method)) {
                writeSimple(out, 204, "No Content", corsBlock, "text/plain", new byte[0]);
                return;
            }

            String pathOnly = rawPath;
            String query = "";
            int qIdx = rawPath.indexOf('?');
            if (qIdx >= 0) {
                pathOnly = rawPath.substring(0, qIdx);
                query = rawPath.substring(qIdx + 1);
            }

            if ("/health".equals(pathOnly) && "GET".equals(method)) {
                writeSimple(out, 200, "OK", corsBlock, "text/plain; charset=utf-8", "ok".getBytes(StandardCharsets.UTF_8));
                return;
            }

            if (!"/proxy".equals(pathOnly)) {
                writeSimple(out, 404, "Not Found", corsBlock, "application/json", "{\"error\":\"Not found\"}".getBytes(StandardCharsets.UTF_8));
                return;
            }

            if (!token.equals(headers.get("x-proxy-token"))) {
                writeSimple(out, 403, "Forbidden", corsBlock, "application/json", "{\"error\":\"Invalid or missing proxy token\"}".getBytes(StandardCharsets.UTF_8));
                return;
            }

            String targetUrl = extractQueryParam(query, "url");
            if (targetUrl == null || (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://"))) {
                writeSimple(out, 400, "Bad Request", corsBlock, "application/json", "{\"error\":\"Missing or invalid url parameter\"}".getBytes(StandardCharsets.UTF_8));
                return;
            }

            byte[] reqBody = null;
            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                reqBody = readRequestBody(in, headers);
                if (reqBody == null) {
                    writeSimple(out, 413, "Payload Too Large", corsBlock, "application/json", "{\"error\":\"Body too large\"}".getBytes(StandardCharsets.UTF_8));
                    return;
                }
            }

            forwardRequest(method, targetUrl, headers, reqBody, corsBlock, out);
        } catch (Throwable ignored) {
        }
    }

    private void forwardRequest(
        String method,
        String targetUrl,
        Map<String, String> reqHeaders,
        byte[] reqBody,
        String corsBlock,
        OutputStream out
    ) throws IOException {
        boolean hasAuth = reqHeaders.containsKey("authorization") || reqHeaders.containsKey("x-api-key");
        boolean isPublicDownload = ("GET".equals(method) || "HEAD".equals(method)) && !hasAuth;

        HttpURLConnection conn = (HttpURLConnection) new URL(targetUrl).openConnection();
        try {
            conn.setRequestMethod(method);
            conn.setConnectTimeout(25_000);
            conn.setReadTimeout(120_000);
            conn.setInstanceFollowRedirects(isPublicDownload);
            conn.setUseCaches(false);
            // Disable transparent gzip mismatch so streaming SSE & binary PDFs stay exact
            conn.setRequestProperty("Accept-Encoding", "identity");

            for (Map.Entry<String, String> e : reqHeaders.entrySet()) {
                String k = e.getKey();
                if (HOP_HEADERS.contains(k) || STRIP_REQ_HEADERS.contains(k)) continue;
                conn.setRequestProperty(k, e.getValue());
            }

            if (reqBody != null && reqBody.length > 0) {
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(reqBody.length);
                try (OutputStream reqOut = conn.getOutputStream()) {
                    reqOut.write(reqBody);
                    reqOut.flush();
                }
            }

            int status = conn.getResponseCode();
            String reason = conn.getResponseMessage();
            if (reason == null || reason.isEmpty()) reason = "OK";

            StringBuilder head = new StringBuilder();
            head.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
            head.append(corsBlock);
            head.append("Connection: close\r\n");

            Map<String, List<String>> respHeaders = conn.getHeaderFields();
            if (respHeaders != null) {
                for (Map.Entry<String, List<String>> e : respHeaders.entrySet()) {
                    String k = e.getKey();
                    if (k == null) continue;
                    String lower = k.toLowerCase(Locale.US);
                    if (HOP_HEADERS.contains(lower) || lower.startsWith("access-control-") || "content-encoding".equals(lower)) {
                        continue;
                    }
                    for (String v : e.getValue()) {
                        head.append(k).append(": ").append(v).append("\r\n");
                    }
                }
            }
            head.append("\r\n");
            out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
            out.flush();

            if (!"HEAD".equals(method) && status != 204 && status != 205 && status != 304) {
                InputStream bodyStream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                if (bodyStream != null) {
                    try (InputStream bs = bodyStream) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = bs.read(buf)) != -1) {
                            out.write(buf, 0, n);
                            out.flush();
                        }
                    }
                }
            }
        } catch (IOException e) {
            String err = "{\"error\":\"Upstream request failed: " + escapeJson(e.getMessage()) + "\"}";
            writeSimple(out, 502, "Bad Gateway", corsBlock, "application/json; charset=utf-8", err.getBytes(StandardCharsets.UTF_8));
        } finally {
            conn.disconnect();
        }
    }

    private static byte[] readRequestBody(InputStream in, Map<String, String> headers) throws IOException {
        String te = headers.get("transfer-encoding");
        if (te != null && te.toLowerCase(Locale.US).contains("chunked")) {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            while (true) {
                String sizeLine = readLine(in);
                if (sizeLine == null) break;
                int semi = sizeLine.indexOf(';');
                if (semi >= 0) sizeLine = sizeLine.substring(0, semi);
                int chunkSize = Integer.parseInt(sizeLine.trim(), 16);
                if (chunkSize <= 0) {
                    readLine(in);
                    break;
                }
                if (baos.size() + chunkSize > MAX_BODY_BYTES) return null;
                byte[] chunk = readExact(in, chunkSize);
                baos.write(chunk);
                readLine(in);
            }
            return baos.toByteArray();
        }
        String cl = headers.get("content-length");
        if (cl == null) return new byte[0];
        int len;
        try {
            len = Integer.parseInt(cl.trim());
        } catch (NumberFormatException e) {
            return new byte[0];
        }
        if (len <= 0) return new byte[0];
        if (len > MAX_BODY_BYTES) return null;
        return readExact(in, len);
    }

    private static byte[] readExact(InputStream in, int len) throws IOException {
        byte[] buf = new byte[len];
        int off = 0;
        while (off < len) {
            int n = in.read(buf, off, len - off);
            if (n < 0) break;
            off += n;
        }
        if (off == len) return buf;
        byte[] trimmed = new byte[off];
        System.arraycopy(buf, 0, trimmed, 0, off);
        return trimmed;
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream(128);
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') baos.write(b);
            if (baos.size() > 65536) break;
        }
        if (b == -1 && baos.size() == 0) return null;
        return baos.toString(StandardCharsets.ISO_8859_1.name());
    }

    private static String extractQueryParam(String query, String key) {
        if (query == null || query.isEmpty()) return null;
        for (String pair : query.split("&")) {
            int idx = pair.indexOf('=');
            if (idx <= 0) continue;
            String k = pair.substring(0, idx);
            if (key.equals(k)) {
                try {
                    return URLDecoder.decode(pair.substring(idx + 1), StandardCharsets.UTF_8.name());
                } catch (Exception ignored) {
                    return pair.substring(idx + 1);
                }
            }
        }
        return null;
    }

    private static String buildCorsHeaders(String origin) {
        return "Access-Control-Allow-Origin: " + (origin == null || origin.isEmpty() ? "*" : origin) + "\r\n"
            + "Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS\r\n"
            + "Access-Control-Allow-Headers: *\r\n"
            + "Access-Control-Expose-Headers: *\r\n"
            + "Access-Control-Max-Age: 86400\r\n";
    }

    private static void writeSimple(OutputStream out, int code, String reason, String cors, String contentType, byte[] body) throws IOException {
        String head = "HTTP/1.1 " + code + " " + reason + "\r\n"
            + cors
            + "Content-Type: " + contentType + "\r\n"
            + "Content-Length: " + body.length + "\r\n"
            + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        if (body.length > 0) out.write(body);
        out.flush();
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", " ");
    }
}
