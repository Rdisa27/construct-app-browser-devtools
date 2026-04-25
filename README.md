# Browser DevTools for Construct

A Construct app that gives the agent remote browser tools:

- Navigate to web pages
- Take viewport, full-page, and element screenshots
- Run JavaScript in the page context, like DevTools Console
- Capture console logs, page errors, and failed requests
- Run trusted Puppeteer scripts for multi-step browser automation

The app runs on Construct's Cloudflare Worker runtime and delegates real browser work to [Browserless](https://browserless.io) through the `/function` REST API.

## Why Browserless

Construct apps run in Workers, so they can't launch Chromium directly. Browserless provides a managed Puppeteer browser over HTTP, which fits the Construct app model and avoids shipping a browser binary inside the app.

## Tools

### `snapshot_page`

Navigates to a URL and returns structured page state:

- final URL
- HTTP status
- title
- visible text
- headings
- links
- console messages
- page errors
- failed requests

Useful for fast inspection before deciding whether a screenshot or console action is needed.

### `take_screenshot`

Navigates to a URL and returns a PNG image content block.

Options:

- viewport screenshot
- full-page screenshot
- CSS selector screenshot
- run JavaScript before the capture
- custom viewport
- extra wait time

### `run_console_javascript`

Navigates to a URL and runs JavaScript inside the page context, similar to pasting code into DevTools Console.

Examples:

```js
document.title
```

```js
[...document.querySelectorAll('a')].slice(0, 10).map(a => ({ text: a.innerText, href: a.href }))
```

```js
await fetch('/api/me').then(r => r.json())
```

For statement blocks, use `return` if you need a value:

```js
const cards = [...document.querySelectorAll('.card')];
return cards.map(card => card.innerText);
```

### `automate_browser`

Runs a trusted Puppeteer script body. Available variables:

- `page`, Puppeteer page
- `context`, JSON object passed with the call
- `serialize`, helper for returning DOM elements and complex values

Example:

```js
await page.goto(context.url, { waitUntil: 'networkidle2' });
await page.click('button');
return await page.title();
```

## Authentication

Install the app in Construct, then connect it with:

- `browserless_token`, required
- `browserless_base_url`, optional, defaults to `https://production-sfo.browserless.io`

## Local development

```bash
pnpm install
pnpm dev
```

Health check:

```bash
curl http://localhost:8787/health
```

List tools:

```bash
curl -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

Local calls that need Browserless auth should include Construct's auth header shape. The easiest path is to publish the app and test through Construct.

## Publishing

1. Push this repo to GitHub, for example `https://github.com/Rdisa27/construct-app-browser-devtools`.
2. Copy the full 40-character commit SHA.
3. Add an entry to `construct-computer/app-registry` under `apps/browser-devtools.json`:

```json
{
  "repo": "https://github.com/Rdisa27/construct-app-browser-devtools",
  "description": "Remote browser tools for navigation, screenshots, console JavaScript, and Puppeteer automation.",
  "versions": [
    { "version": "0.1.0", "commit": "REPLACE_WITH_40_CHAR_COMMIT_SHA", "date": "2026-04-25" }
  ]
}
```

4. Open a PR against `construct-computer/app-registry`.

## Security notes

This app executes JavaScript and Puppeteer scripts requested by the Construct agent. Treat it like a DevTools remote control. Only connect it to a Browserless account you trust, and only run scripts for sites where you have permission to automate or inspect.

Browserless sessions are stateless per tool call in this version. If you need persistent cookies or login sessions, add a dedicated profile/session mechanism before using it for authenticated sites.
