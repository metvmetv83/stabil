/**
 * IPTV Proxy — Render.com
 * Render → codetabs.com → Stream sunucusu
 * codetabs whitelist'te, pipe ile akış — donma yok
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

const PROXIES = [
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
];

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const parsed    = url.parse(req.url, true);
  const targetUrl = parsed.query.url;
  const proxyIdx  = parseInt(parsed.query.proxy || "0");

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

  const tryOrder = [proxyIdx, ...[0,1,2].filter(i => i !== proxyIdx)];
  tryProxies(req, res, targetUrl, tryOrder, 0);
});

server.listen(PORT, () => console.log(`Listening on ${PORT}`));

function tryProxies(clientReq, clientRes, targetUrl, order, attempt) {
  if (attempt >= order.length) {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, CORS);
      clientRes.end(JSON.stringify({ error: "Tüm proxy'ler başarısız" }));
    }
    return;
  }

  const idx      = order[attempt];
  const proxyUrl = PROXIES[idx](targetUrl);

  fetchViaProxy(proxyUrl, clientReq.headers.range, (err, proxyRes) => {
    if (err || !proxyRes || (proxyRes.statusCode !== 200 && proxyRes.statusCode !== 206)) {
      console.log(`Proxy ${idx} başarısız (${err?.message || proxyRes?.statusCode}), sonraki...`);
      if (proxyRes) proxyRes.resume();
      tryProxies(clientReq, clientRes, targetUrl, order, attempt + 1);
      return;
    }

    const contentType = proxyRes.headers["content-type"] || "";
    const isM3U8 = targetUrl.includes(".m3u8") || targetUrl.includes(".m3u")
      || contentType.includes("mpegurl");

    if (isM3U8) {
      let body = "";
      proxyRes.setEncoding("utf8");
      proxyRes.on("data", chunk => body += chunk);
      proxyRes.on("end", () => {
        if (!body.trim().startsWith("#EXTM3U") && !body.trim().startsWith("#EXT-X-")) {
          tryProxies(clientReq, clientRes, targetUrl, order, attempt + 1);
          return;
        }
        const base      = getRequestBase(clientReq);
        const rewritten = rewriteM3U8(body, targetUrl, base, idx);
        clientRes.writeHead(200, {
          "Content-Type":  "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache, no-store",
          "X-Proxy-Used":  String(idx),
          ...CORS,
        });
        clientRes.end(rewritten);
      });
    } else {
      const resHeaders = {
        "Content-Type":  contentType || "video/mp2t",
        "Cache-Control": "no-cache",
        "X-Proxy-Used":  String(idx),
        ...CORS,
      };
      if (proxyRes.statusCode === 206) {
        if (proxyRes.headers["content-range"])  resHeaders["Content-Range"]  = proxyRes.headers["content-range"];
        if (proxyRes.headers["content-length"]) resHeaders["Content-Length"] = proxyRes.headers["content-length"];
        resHeaders["Accept-Ranges"] = "bytes";
      }
      clientRes.writeHead(proxyRes.statusCode, resHeaders);
      proxyRes.pipe(clientRes);
    }
  });
}

function fetchViaProxy(proxyUrl, rangeHeader, callback) {
  let parsed;
  try { parsed = new URL(proxyUrl); } catch { return callback(new Error("bad url")); }

  const lib = parsed.protocol === "https:" ? https : http;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0",
    "Accept":     "*/*",
  };
  if (rangeHeader) headers["Range"] = rangeHeader;

  const req = lib.request({
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   "GET",
    headers,
    timeout:  12000,
  }, (res) => callback(null, res));

  req.on("timeout", () => { req.destroy(); callback(new Error("timeout")); });
  req.on("error",   (e) => callback(e));
  req.end();
}

function rewriteM3U8(text, baseUrl, proxyBase, proxyIdx) {
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

    return `${proxyBase}/?url=${encodeURIComponent(abs)}&proxy=${proxyIdx}`;
  }).join("\n");
}

function getRequestBase(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host  = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}
