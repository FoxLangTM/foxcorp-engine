// wrangler.toml:
// name = "universal-iframe-proxy"
// main = "src/index.js"
// compatibility_date = "2024-01-01"

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const target = url.searchParams.get("url");

      if (!target) {
        return new Response(
          `Brak parametru ?url=... 
Użycie: ?url=https://example.com`,
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } }
        );
      }

      if (target.startsWith(url.origin)) {
        return new Response("Pętla proxy jest zablokowana.", {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      const targetUrl = new URL(target);

      // Przekazujemy metodę i body (dla POST itp.)
      const init = {
        method: request.method,
        headers: buildForwardHeaders(request.headers, targetUrl),
        body: request.method !== "GET" && request.method !== "HEAD" ? await request.arrayBuffer() : undefined,
        redirect: "follow",
      };

      const upstreamResponse = await fetch(targetUrl.toString(), init);

      // Skopiuj nagłówki i usuń blokujące iframe
      const newHeaders = new Headers(upstreamResponse.headers);

      stripSecurityHeaders(newHeaders);

      const contentType = newHeaders.get("content-type") || "";

      // Obsługa binariów (obrazki, wideo, itp.)
      if (!contentType.includes("text/html")) {
        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          headers: newHeaders,
        });
      }

      // HTML – przepisywanie linków
      const text = await upstreamResponse.text();
      const rewritten = rewriteHtml(text, url, targetUrl);

      newHeaders.set("content-type", "text/html; charset=utf-8");

      return new Response(rewritten, {
        status: upstreamResponse.status,
        headers: newHeaders,
      });
    } catch (e) {
      return new Response("Błąd workera: " + (e && e.message ? e.message : String(e)), {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },
};

/**
 * Buduje nagłówki do przekazania dalej, usuwając te, które nie mają sensu dla upstream.
 */
function buildForwardHeaders(incomingHeaders, targetUrl) {
  const headers = new Headers();

  for (const [key, value] of incomingHeaders.entries()) {
    const lower = key.toLowerCase();

    // Nie przekazujemy nagłówków specyficznych dla hosta workera
    if (["host", "cf-connecting-ip", "x-forwarded-for", "x-real-ip"].includes(lower)) {
      continue;
    }

    // Origin/Referer przepinamy na target
    if (lower === "origin" || lower === "referer") {
      headers.set(key, targetUrl.origin + "/");
      continue;
    }

    headers.set(key, value);
  }

  // Ustawiamy Host na target
  headers.set("host", targetUrl.host);

  return headers;
}

/**
 * Usuwa nagłówki bezpieczeństwa, które blokują iframe.
 */
function stripSecurityHeaders(headers) {
  const toDelete = [
    "x-frame-options",
    "content-security-policy",
    "content-security-policy-report-only",
    "x-content-type-options",
    "x-xss-protection",
    "referrer-policy",
    "permissions-policy",
    "strict-transport-security",
  ];

  for (const h of toDelete) {
    headers.delete(h);
  }

  // Możemy też ustawić własne, bardziej liberalne
  headers.set("x-frame-options", "ALLOWALL");
}

/**
 * Przepisuje linki w HTML tak, aby przechodziły przez proxy.
 * To jest prosty, regexowy approach – nie idealny, ale działa dla wielu stron.
 */
function rewriteHtml(html, workerUrl, targetUrl) {
  const proxyBase = workerUrl.origin + workerUrl.pathname;
  const targetOrigin = targetUrl.origin;

  // Funkcja pomocnicza do budowy URL przez proxy
  const proxify = (url) => {
    try {
      if (!url) return url;
      // Ignorujemy anchor (#) i javascript:
      if (url.startsWith("#") || url.startsWith("javascript:")) return url;

      // Absolutny URL
      let u;
      if (url.startsWith("http://") || url.startsWith("https://")) {
        u = new URL(url);
      } else if (url.startsWith("//")) {
        u = new URL(targetUrl.protocol + url);
      } else {
        // względny
        u = new URL(url, targetUrl);
      }

      return `${proxyBase}?url=${encodeURIComponent(u.toString())}`;
    } catch {
      return url;
    }
  };

  // Przepisywanie href/src w prosty sposób
  html = html.replace(
    /(href|src)\s*=\s*"(.*?)"/gi,
    (match, attr, value) => `${attr}="${proxify(value)}"`
  );

  html = html.replace(
    /(href|src)\s*=\s*'(.*?)'/gi,
    (match, attr, value) => `${attr}='${proxify(value)}'`
  );

  // Przepisywanie w inline JS (bardzo ograniczone, ale czasem pomaga)
  // np. location.href = '...';
  html = html.replace(
    /(location\.href\s*=\s*['"])([^'"]+)(['"])/gi,
    (match, p1, url, p3) => `${p1}${proxify(url)}${p3}`
  );

  // Dodajemy mały banner debugowy (opcjonalnie)
  const banner = `
<!-- Proxy banner -->
<div style="position:fixed;bottom:0;left:0;right:0;background:#000;color:#0f0;font:12px monospace;z-index:999999;padding:2px 6px;opacity:0.7;">
  Proxy via Cloudflare Worker – niektóre strony mogą nadal blokować iframe (CSP, JS, itp.).
</div>
`;

  if (html.includes("</body>")) {
    html = html.replace("</body>", banner + "</body>");
  } else {
    html += banner;
  }

  return html;
}
