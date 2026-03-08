/**
 * IPTV Proxy — Render.com için Node.js
 * Doğrudan stream, araya codetabs girmiyor
 *
 * Kullanım:
 *   https://RENDER_URL/?url=http://apx-me.com:8880/live:persian_share/Hs6guU9ziF/49304
 */

const http  = require("http");
const https = require("https");
const url   = require("url");

const PORT = process.env.PORT || 3000;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// ─── SERVER ──────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const parsed    = url.parse(req.url, true);
  const targetUrl = parsed.query.url;

  if (parsed.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify({ status: "ok", node: process.version }, null, 2));
    return;
  }

  if (!targetUrl) {
    res.writeHead(400, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify({
      usage: "?url=STREAM_URL",
      example: "?url=http://apx-me.com:8880/live:persian_share/Hs6guU9ziF/49304",
    }));
    return;
  }

  proxyRequest(req, res, targetUrl);
});

server.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));

// ─── PROXY ───────────────────────────────────────────────────────────────────
function proxyRequest(clientReq, clientRes, targetUrl) {
  let parsed;
  try { parsed = new URL(targetUrl); }
  catch {
    clientRes.writeHead(400, CORS);
    clientRes.end("Geçersiz URL");
    return;
  }

  const isHttps = parsed.protocol === "https:";
  const lib     = isHttps ? https : http;

  const options = {
    hostname: parsed.hostname,
    port:     parsed.port || (isHttps ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0",
      "Accept":     "*/*",
      // Range başlığını client'tan ilet
      ...(clientReq.headers.range ? { "Range": clientReq.headers.range } : {}),
    },
    timeout: 15000,
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    const contentType = proxyRes.headers["content-type"] || "";
    const isM3U8 = targetUrl.includes(".m3u8") || targetUrl.includes(".m3u")
      || contentType.includes("mpegurl");

    if (isM3U8) {
      // M3U8: tüm içeriği topla, URL'leri rewrite et
      let body = "";
      proxyRes.setEncoding("utf8");
      proxyRes.on("data", chunk => body += chunk);
      proxyRes.on("end", () => {
        const base      = getRequestBase(clientReq);
        const rewritten = rewriteM3U8(body, targetUrl, base);

        clientRes.writeHead(200, {
          "Content-Type":  "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache, no-store",
          ...CORS,
        });
        clientRes.end(rewritten);
      });
    } else {
      // Binary stream (TS, MP4) — pipe et, kopyalama yok
      const statusCode  = proxyRes.statusCode;
      const resHeaders  = {
        "Content-Type":  contentType || "video/mp2t",
        "Cache-Control": "no-cache",
        ...CORS,
      };

      if (statusCode === 206) {
        if (proxyRes.headers["content-range"])  resHeaders["Content-Range"]  = proxyRes.headers["content-range"];
        if (proxyRes.headers["content-length"]) resHeaders["Content-Length"] = proxyRes.headers["content-length"];
        resHeaders["Accept-Ranges"] = "bytes";
      }

      clientRes.writeHead(statusCode, resHeaders);
      proxyRes.pipe(clientRes); // direkt pipe — buffer yok, donma yok
    }
  });

  proxyReq.on("timeout", () => {
    proxyReq.destroy();
    if (!clientRes.headersSent) {
      clientRes.writeHead(504, CORS);
      clientRes.end("Timeout");
    }
  });

  proxyReq.on("error", (err) => {
    console.error("Proxy error:", err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, CORS);
      clientRes.end("Proxy hatası: " + err.message);
    }
  });

  proxyReq.end();
}

// ─── M3U8 REWRITE ────────────────────────────────────────────────────────────
function rewriteM3U8(text, baseUrl, proxyBase) {
  const base     = new URL(baseUrl);
  const basePath = base.pathname.substring(0, base.pathname.lastIndexOf("/") + 1);

  return text.split("\n").map(line => {
    line = line.trim();
    if (!line || line.startsWith("#")) return line;

    let abs;
    if (line.startsWith("http://") || line.startsWith("https://")) {
      abs = line;
    } else if (line.startsWith("/")) {
      abs = `${base.protocol}//${base.host}${line}`;
    } else {
      abs = `${base.protocol}//${base.host}${basePath}${line}`;
    }

    return `${proxyBase}/?url=${encodeURIComponent(abs)}`;
  }).join("\n");
}

function getRequestBase(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host  = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}
