export default {
  async fetch(request) {
    const { searchParams, origin: workerOrigin } = new URL(request.url);
    const targetUrl = searchParams.get('url');

    if (!targetUrl) return new Response('Brak URL', { status: 400 });

    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        }
      });

      const contentType = response.headers.get('content-type') || '';
      
      // Jeśli to nie jest HTML, po prostu prześlij plik (obrazki, style)
      if (!contentType.includes('text/html')) {
        return new Response(response.body, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': contentType
          }
        });
      }

      let html = await response.text();
      const targetOrigin = new URL(targetUrl).origin;

      // --- INTELIGENTNE PRZEPISYWANIE LINKÓW ---
      // 1. Naprawiamy linki absolutne (zaczynające się od /)
      html = html.replace(/(href|src|action)=["']\/(?!\/)/g, `$1="${workerOrigin}/?url=${targetOrigin}/`);
      
      // 2. Naprawiamy linki pełne (http...), aby też szły przez nas
      // Ale omijamy te, które już prowadzą do Twojego workera
      const linkRegex = /(href|src|action)=["'](https?:\/\/[^"']+)["']/g;
      html = html.replace(linkRegex, (match, attr, url) => {
        if (url.includes(workerOrigin)) return match;
        return `${attr}="${workerOrigin}/?url=${encodeURIComponent(url)}"`;
      });

      // 3. Wstrzykujemy skrypt, który wymusza otwieranie wszystkiego w ramce
      const inject = `
        <head>
        <base href="${targetOrigin}/">
        <script>
          // Blokujemy próby "wyjścia" z ramki
          window.top = window.self;
          window.parent = window.self;
        </script>
      `;
      html = html.replace(/<head>/i, inject);

      const proxyResponse = new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'X-Frame-Options': 'ALLOWALL'
        }
      });

      return proxyResponse;
    } catch (e) {
      return new Response('Error: ' + e.message, { status: 500 });
    }
  }
};
