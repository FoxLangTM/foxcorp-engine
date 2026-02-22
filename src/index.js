export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Requested-With, FoxEngine-Core",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    try {
      const url = new URL(request.url);
      let target = url.searchParams.get("url");

      if (!target && url.search.includes("url=")) {
        target = decodeURIComponent(url.search.split("url=")[1]);
      }

      if (!target) return new Response("FoxEngine: No URL", { status: 400, headers: { "Access-Control-Allow-Origin": "*" } });

      const targetUrl = new URL(target);
      
      // Łączymy bezpieczeństwo z udawaniem przeglądarki
      const init = {
        method: request.method,
        headers: buildForwardHeaders(request.headers, targetUrl),
        body: request.method !== "GET" && request.method !== "HEAD" ? await request.arrayBuffer() : undefined,
        redirect: "follow",
      };

      const response = await fetch(targetUrl.toString(), init);
      const newHeaders = new Headers(response.headers);

      stripSecurityHeaders(newHeaders);
      newHeaders.set("Access-Control-Allow-Origin", "*");

      const contentType = newHeaders.get("content-type") || "";

      // Jeśli to nie tekst, zwracamy bezpośrednio (naprawia ikony/obrazki)
      if (!contentType.includes("text/html") && !contentType.includes("text/css")) {
        return new Response(response.body, { status: response.status, headers: newHeaders });
      }

      let text = await response.text();
      text = rewriteHtml(text, url, targetUrl);

      return new Response(text, { status: response.status, headers: newHeaders });
    } catch (e) {
      return new Response("Err: " + e.message, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
    }
  },
};

function buildForwardHeaders(incomingHeaders, targetUrl) {
  const headers = new Headers();
  // Udajemy przeglądarkę, aby uniknąć 403 na DDG
  headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
  headers.set("Accept-Language", "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7");
  headers.set("Host", targetUrl.host);
  headers.set("Referer", targetUrl.origin + "/");
  
  // Zachowujemy kluczowy nagłówek dla Twojego JS
  if (incomingHeaders.get("X-Requested-With")) {
    headers.set("X-Requested-With", incomingHeaders.get("X-Requested-With"));
  }
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