#!/usr/bin/env node
/**
 * Build README.html (a single shareable file) from README.md:
 * Mindfire logo large in the header, small in the footer, copyright line, print-friendly.
 * The logo is embedded once as a data URI, so the HTML works when emailed on its own.
 *
 *   npm run readme        (needs the dev dependency: npm install)
 */

const fs = require('fs');
const path = require('path');

let MarkdownIt;
try { MarkdownIt = require('markdown-it'); } catch {
  console.error('markdown-it is not installed. Run "npm install" in the kit folder first.');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const logo = fs.readFileSync(path.join(ROOT, 'installer', 'public', 'assets', 'mindfire-logo.webp')).toString('base64');
const year = new Date().getFullYear();
const title = (src.match(/^# (.+)$/m) || [, 'README'])[1];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const md = new MarkdownIt({ html: false, linkify: true });
const body = md.render(src).replace(/<a href="(https?:[^"]+)"/g, '<a href="$1" target="_blank" rel="noopener"');

const css = `
:root{--brand:#2563eb;--line:#e5e7eb;--muted:#6b7280;--logo:url("data:image/webp;base64,${logo}")}
body{font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937;background:#f6f7fb;margin:0}
.site-header{background:#fff;border-bottom:1px solid var(--line);padding:14px 24px}
.site-header .inner{max-width:960px;margin:0 auto;display:flex;align-items:center;gap:16px}
.logo{background:var(--logo) no-repeat left center/contain;display:inline-block;flex:none}
.logo-lg{width:130px;height:52px}.logo-sm{width:60px;height:24px}
.divider{width:1px;height:34px;background:var(--line)}
.site-title{font-weight:700;font-size:17px}.site-title span{color:var(--muted);font-weight:400}
main{max-width:960px;margin:28px auto;background:#fff;border:1px solid var(--line);border-radius:14px;padding:36px 44px}
h1{font-size:28px;margin-top:0;border-bottom:3px solid var(--brand);padding-bottom:10px}h2{font-size:21px;margin-top:34px;border-bottom:1px solid var(--line);padding-bottom:6px}h3{font-size:17px;margin-top:24px}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px}th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}th{background:#eef2ff}tr:nth-child(even) td{background:#fafafa}
code{background:#f3f4f6;padding:1px 6px;border-radius:4px;font-size:13px;font-family:ui-monospace,Consolas,monospace}
pre{background:#0f172a;color:#e2e8f0;padding:14px 16px;border-radius:8px;overflow:auto}pre code{background:none;color:inherit;padding:0}
a{color:var(--brand)}li{margin:3px 0}
.site-footer{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:16px 24px 28px;color:var(--muted);font-size:13px}
@media print{body{background:#fff}main{border:0;margin:0;padding:0}.logo{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
@media (max-width:700px){main{padding:22px}.logo-lg{width:100px;height:40px}.divider{display:none}}`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Mindfire Solutions</title><style>${css}</style></head>
<body>
<header class="site-header"><div class="inner">
  <span class="logo logo-lg" role="img" aria-label="Mindfire Solutions"></span>
  <span class="divider" aria-hidden="true"></span>
  <span class="site-title">QA Agent Framework <span>· Client Kit</span></span>
</div></header>
<main>
${body}</main>
<footer class="site-footer">
  <span class="logo logo-sm" role="img" aria-label="Mindfire Solutions"></span>
  <span>© ${year} Mindfire Solutions. All rights reserved.</span>
</footer>
</body></html>
`;

fs.writeFileSync(path.join(ROOT, 'README.html'), html);
console.log(`README.html built (${Math.round(html.length / 1024)} KB)`);
