export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const target = url.searchParams.get("url");

      // 1. POPRAWIONY I DOMKNIĘTY BLOK OPTIONS
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Requested-With, FoxEngine-Core",
          },
        });
      }

      if (!target) {
        return new Response(`Brak parametru ?url=...`, { 
          status: 400, 
          headers: { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" } 
        });
      }

      if (target.startsWith(url.origin)) {
        return new Response("Pętla proxy zablokowana.", { status: 400 });
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
      newHeaders.set("Access-Control-Allow-Origin", "*"); // Dodajemy CORS do odpowiedzi

      const contentType = newHeaders.get("content-type") || "";

      // Obsługa binariów i CSS (CSS też chcemy przepisywać, by linki w nim działały)
      if (!contentType.includes("text/html") && !contentType.includes("text/css")) {
        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          headers: newHeaders,
        });
      }

      const text = await upstreamResponse.text();
      const rewritten = rewriteHtml(text, url, targetUrl);

      return new Response(rewritten, {
        status: upstreamResponse.status,
        headers: newHeaders,
      });
    } catch (e) {
      return new Response("Błąd workera: " + e.message, { status: 500 });
    }
  },
};

function buildForwardHeaders(incomingHeaders, targetUrl) {
  const headers = new Headers();
  headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
  headers.set("Accept-Language", "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7");
  headers.set("Host", targetUrl.host);
  headers.set("Referer", targetUrl.origin + "/");

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


async function handleRequest(request) {
  const url = new URL(request.url);
  let targetUrl = url.searchParams.get('url');

  if (!targetUrl) return new Response("Missing URL", { status: 400 });

  // KLUCZ: Tworzymy zupełnie nowe nagłówki, usuwając te od Cloudflare
  const headers = new Headers();
  headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36");
  headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8");
  headers.set("Accept-Language", "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7");
  headers.set("Cache-Control", "no-cache");

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: headers,
      redirect: "follow"
    });

    // Klonujemy odpowiedź, aby dodać nagłówki CORS, by Twoja strona mogła ją odczytać
    const newResp = new Response(response.body, response);
    newResp.headers.set("Access-Control-Allow-Origin", "*");
    newResp.headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    
    // Usuwamy nagłówki bezpieczeństwa, które mogłyby blokować wyświetlanie w iframe
    newResp.headers.delete("Content-Security-Policy");
    newResp.headers.delete("X-Frame-Options");

    return newResp;
  } catch (e) {
    return new Response("FoxEngine Error: " + e.message, { status: 500 });
  }
}

  // Dodajemy banner (skoro go używasz w kodzie poniżej)
  const banner = `<div style="display:none">FoxEngine Proxy Active</div>`;

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
    .replace(/url\((['"]?)(.*?)\1\)/gi, (m, quote, val) => `url(${quote}${proxify(val)}${quote})`)
    .replace("</body>", banner + "</body>");
}