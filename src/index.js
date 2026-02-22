export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      let target = url.searchParams.get("url");

      if (!target && url.search.includes("url=")) {
        target = decodeURIComponent(url.search.split("url=")[1]);
      }

      if (!target) {
        return new Response("FoxEngine: No URL", { 
          status: 400, 
          headers: { "Access-Control-Allow-Origin": "*" } 
        });
      }

      const targetUrl = new URL(target);
      const init = {
        method: request.method,
        headers: buildForwardHeaders(request.headers, targetUrl),
        body: request.method !== "GET" && request.method !== "HEAD" ? await request.arrayBuffer() : undefined,
        redirect: "follow",
      };

      const upstreamResponse = await fetch(targetUrl.toString(), init);
      const newHeaders = new Headers(upstreamResponse.headers);

      stripSecurityHeaders(newHeaders);
      newHeaders.set("Access-Control-Allow-Origin", "*");

      const contentType = newHeaders.get("content-type") || "";

      if (!contentType.includes("text/html") && !contentType.includes("text/css")) {
        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          headers: newHeaders,
        });
      }

      let text = await upstreamResponse.text();
      text = rewriteHtml(text, url, targetUrl);

      return new Response(text, {
        status: upstreamResponse.status,
        headers: newHeaders,
      });
    } catch (e) {
      return new Response("Err: " + e.message, { status: 500 });
    }
  },
};

function buildForwardHeaders(incomingHeaders, targetUrl) {
  const headers = new Headers();
  const clientIP = incomingHeaders.get("cf-connecting-ip") || "";

  for (const [key, value] of incomingHeaders.entries()) {
    const lower = key.toLowerCase();
    if (["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "x-forwarded-for", "x-real-ip"].includes(lower)) continue;
    if (lower === "origin" || lower === "referer") {
      headers.set(key, targetUrl.origin + "/");
      continue;
    }
    headers.set(key, value);
  }

  headers.set("host", targetUrl.host);
  if (clientIP) {
    headers.set("X-Forwarded-For", clientIP);
    headers.set("X-Real-IP", clientIP);
  }
  headers.set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  return headers;
}

function stripSecurityHeaders(headers) {
  const toDelete = ["x-frame-options", "content-security-policy", "content-security-policy-report-only", "x-content-type-options", "x-xss-protection", "referrer-policy", "permissions-policy", "strict-transport-security"];
  for (const h of toDelete) headers.delete(h);
  headers.set("x-frame-options", "ALLOWALL");
}

function rewriteHtml(html, workerUrl, targetUrl) {
  const proxyBase = workerUrl.origin + workerUrl.pathname;
  const proxify = (url) => {
    try {
      if (!url || url.startsWith("#") || url.startsWith("javascript:") || url.startsWith("data:")) return url;
      let u = url.startsWith("http") ? new URL(url) : (url.startsWith("//") ? new URL(targetUrl.protocol + url) : new URL(url, targetUrl));
      return `${proxyBase}?url=${encodeURIComponent(u.toString())}`;
    } catch { return url; }
  };

  return html
    .replace(/(href|src|action|data-src|srcset)\s*=\s*"(.*?)"/gi, (m, attr, val) => {
      if (attr === 'srcset') {
         return `${attr}="${val.split(',').map(s => {
           const parts = s.trim().split(/\s+/);
           parts[0] = proxify(parts[0]);
           return parts.join(' ');
         }).join(', ')}"`;
      }
      return `${attr}="${proxify(val)}"`;
    })
    .replace(/(href|src)\s*=\s*'(.*?)'/gi, (m, attr, val) => `${attr}='${proxify(val)}'`)
    .replace(/url\((['"]?)(.*?)\1\)/gi, (m, quote, val) => `url(${quote}${proxify(val)}${quote})`);
}