import { ConstructApp } from '@construct-computer/app-sdk';

const app = new ConstructApp({ name: 'browser-devtools', version: '0.1.0' });

type AnyRecord = Record<string, any>;

function errorResult(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function getBrowserlessConfig(ctx: any) {
  const auth = ctx?.auth ?? {};
  const token = String(auth.browserless_token ?? auth.api_key ?? auth.token ?? '').trim();
  if (!token) {
    throw new Error('Browserless token missing. Connect this app with a Browserless API token first.');
  }

  const rawBase = String(auth.browserless_base_url ?? 'https://production-sfo.browserless.io').trim();
  const baseUrl = rawBase.replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(baseUrl)) {
    throw new Error('browserless_base_url must be an HTTPS origin, for example https://production-sfo.browserless.io');
  }

  return { token, baseUrl };
}

async function callBrowserless(ctx: any, code: string, context: AnyRecord) {
  const { token, baseUrl } = getBrowserlessConfig(ctx);
  const response = await fetch(`${baseUrl}/function?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, context }),
  });

  const contentType = response.headers.get('content-type') ?? '';
  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(`Browserless failed with ${response.status}: ${bodyText.slice(0, 1200)}`);
  }

  if (!contentType.includes('application/json')) {
    return { raw: bodyText, contentType };
  }

  const parsed = JSON.parse(bodyText);
  if (parsed && typeof parsed === 'object' && 'data' in parsed && 'type' in parsed) return parsed.data;
  return parsed;
}

const sharedBrowserHelpers = `
function compact(value, limit = 2000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}
function serialize(value) {
  if (typeof value === 'undefined') return { kind: 'undefined' };
  if (value === null) return { kind: 'null', value: null };
  if (typeof value === 'function') return { kind: 'function', value: value.toString().slice(0, 1000) };
  if (typeof value === 'symbol') return { kind: 'symbol', value: String(value) };
  if (value instanceof Element) {
    return {
      kind: 'element',
      tag: value.tagName.toLowerCase(),
      id: value.id || null,
      className: value.className || null,
      text: compact(value.textContent || '', 1000),
      outerHTML: compact(value.outerHTML || '', 2000),
    };
  }
  try {
    return { kind: Object.prototype.toString.call(value), value: JSON.parse(JSON.stringify(value)) };
  } catch (err) {
    return { kind: Object.prototype.toString.call(value), value: String(value) };
  }
}
async function runConsoleSource(source) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    return await (0, eval)('(async () => { return (' + source + '); })()');
  } catch (expressionError) {
    const fn = new AsyncFunction(source);
    return await fn();
  }
}
async function preparePage(page, context, logs, pageErrors, failedRequests) {
  page.on('console', (msg) => logs.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', (err) => pageErrors.push({ message: err.message, stack: err.stack || null }));
  page.on('requestfailed', (req) => failedRequests.push({ url: req.url(), method: req.method(), error: req.failure()?.errorText || null }));
  if (context.viewport && Number(context.viewport.width) && Number(context.viewport.height)) {
    await page.setViewport({
      width: Math.min(Math.max(Number(context.viewport.width), 320), 3000),
      height: Math.min(Math.max(Number(context.viewport.height), 240), 3000),
      deviceScaleFactor: Math.min(Math.max(Number(context.viewport.deviceScaleFactor || 1), 1), 3),
    });
  }
  if (context.user_agent) await page.setUserAgent(String(context.user_agent));
  if (context.headers && typeof context.headers === 'object') await page.setExtraHTTPHeaders(context.headers);
  const response = await page.goto(context.url, {
    waitUntil: context.wait_until || 'networkidle2',
    timeout: Math.min(Math.max(Number(context.timeout_ms || 45000), 5000), 120000),
  });
  if (context.javascript) {
    await page.evaluate(async (source) => {
      const result = await (0, eval)('(async () => { ' + source + '\n})()');
      return result;
    }, context.javascript);
  }
  if (context.wait_ms) await new Promise((resolve) => setTimeout(resolve, Math.min(Number(context.wait_ms), 30000)));
  return response;
}
`;

const snapshotCode = `
export default async ({ page, context }) => {
  ${sharedBrowserHelpers}
  const logs = [];
  const pageErrors = [];
  const failedRequests = [];
  const response = await preparePage(page, context, logs, pageErrors, failedRequests);
  const maxChars = Math.min(Math.max(Number(context.max_chars || 8000), 1000), 50000);
  const data = await page.evaluate((maxChars) => {
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 80).map((a) => ({
      text: (a.textContent || '').trim().slice(0, 160),
      href: a.href,
    }));
    const headings = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 60).map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 220),
    }));
    const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    return { title: document.title, text: text.slice(0, maxChars), links, headings };
  }, maxChars);
  return {
    data: {
      url: context.url,
      final_url: page.url(),
      status: response?.status() ?? null,
      ok: response?.ok() ?? null,
      ...data,
      console: logs.slice(-80),
      page_errors: pageErrors.slice(-30),
      failed_requests: failedRequests.slice(-50),
    },
    type: 'application/json',
  };
};
`;

const screenshotCode = `
export default async ({ page, context }) => {
  ${sharedBrowserHelpers}
  const logs = [];
  const pageErrors = [];
  const failedRequests = [];
  const response = await preparePage(page, context, logs, pageErrors, failedRequests);
  let screenshot;
  let selector_found = null;
  if (context.selector) {
    const element = await page.$(String(context.selector));
    selector_found = Boolean(element);
    if (!element) throw new Error('Selector not found: ' + context.selector);
    screenshot = await element.screenshot({ encoding: 'base64', type: 'png' });
  } else {
    screenshot = await page.screenshot({ encoding: 'base64', type: 'png', fullPage: Boolean(context.full_page) });
  }
  return {
    data: {
      url: context.url,
      final_url: page.url(),
      status: response?.status() ?? null,
      title: await page.title(),
      selector_found,
      mime_type: 'image/png',
      screenshot_base64: screenshot,
      console: logs.slice(-80),
      page_errors: pageErrors.slice(-30),
      failed_requests: failedRequests.slice(-50),
    },
    type: 'application/json',
  };
};
`;

const runConsoleCode = `
export default async ({ page, context }) => {
  ${sharedBrowserHelpers}
  const logs = [];
  const pageErrors = [];
  const failedRequests = [];
  const response = await preparePage(page, context, logs, pageErrors, failedRequests);
  const value = await page.evaluate(async (source) => {
    ${sharedBrowserHelpers}
    const result = await runConsoleSource(source);
    return serialize(result);
  }, context.code);
  let screenshot_base64 = null;
  if (context.include_screenshot) screenshot_base64 = await page.screenshot({ encoding: 'base64', type: 'png', fullPage: false });
  return {
    data: {
      url: context.url,
      final_url: page.url(),
      status: response?.status() ?? null,
      title: await page.title(),
      result: value,
      screenshot_base64,
      console: logs.slice(-120),
      page_errors: pageErrors.slice(-50),
      failed_requests: failedRequests.slice(-50),
    },
    type: 'application/json',
  };
};
`;

const automateCode = `
export default async ({ page, context }) => {
  ${sharedBrowserHelpers}
  const logs = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => logs.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', (err) => pageErrors.push({ message: err.message, stack: err.stack || null }));
  page.on('requestfailed', (req) => failedRequests.push({ url: req.url(), method: req.method(), error: req.failure()?.errorText || null }));
  if (context.viewport && Number(context.viewport.width) && Number(context.viewport.height)) {
    await page.setViewport({ width: Number(context.viewport.width), height: Number(context.viewport.height), deviceScaleFactor: Number(context.viewport.deviceScaleFactor || 1) });
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('page', 'context', 'serialize', context.script);
  const result = await fn(page, context.script_context || {}, serialize);
  let screenshot_base64 = null;
  if (context.include_screenshot) screenshot_base64 = await page.screenshot({ encoding: 'base64', type: 'png', fullPage: Boolean(context.full_page) });
  return {
    data: {
      final_url: page.url(),
      title: await page.title().catch(() => null),
      result: serialize(result),
      screenshot_base64,
      console: logs.slice(-150),
      page_errors: pageErrors.slice(-50),
      failed_requests: failedRequests.slice(-80),
    },
    type: 'application/json',
  };
};
`;

function normalizeUrl(value: unknown) {
  const url = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
  return url;
}

function baseContext(args: AnyRecord) {
  return {
    url: normalizeUrl(args.url),
    wait_until: args.wait_until || 'networkidle2',
    timeout_ms: args.timeout_ms || 45000,
    wait_ms: args.wait_ms || 0,
    javascript: args.javascript || '',
    viewport: {
      width: Number(args.viewport_width || 1440),
      height: Number(args.viewport_height || 900),
      deviceScaleFactor: Number(args.device_scale_factor || 1),
    },
    user_agent: args.user_agent || '',
    headers: args.headers || undefined,
  };
}

app.tool('snapshot_page', {
  description: 'Navigate to a web page and return title, final URL, status, visible text, headings, links, console output, page errors, and failed requests.',
  parameters: {
    url: { type: 'string', description: 'HTTP or HTTPS URL to open.' },
    javascript: { type: 'string', description: 'Optional JavaScript to run before collecting the snapshot. Runs in the page context.' },
    max_chars: { type: 'number', description: 'Maximum visible text characters to return. Default 8000, max 50000.' },
    wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'], description: 'Puppeteer navigation wait condition. Default networkidle2.' },
    wait_ms: { type: 'number', description: 'Extra wait after navigation and JavaScript, in milliseconds. Max 30000.' },
    viewport_width: { type: 'number', description: 'Viewport width. Default 1440.' },
    viewport_height: { type: 'number', description: 'Viewport height. Default 900.' },
  },
  handler: async (args, ctx) => {
    try {
      const data = await callBrowserless(ctx, snapshotCode, { ...baseContext(args), max_chars: args.max_chars });
      return JSON.stringify(data, null, 2);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
});

app.tool('take_screenshot', {
  description: 'Navigate to a web page and return a PNG screenshot. Can capture the viewport, full page, or a CSS selector after optional JavaScript runs.',
  parameters: {
    url: { type: 'string', description: 'HTTP or HTTPS URL to open.' },
    javascript: { type: 'string', description: 'Optional JavaScript to run before the screenshot. Runs in the page context.' },
    selector: { type: 'string', description: 'Optional CSS selector to capture only one element.' },
    full_page: { type: 'boolean', description: 'Capture the full page instead of viewport. Ignored when selector is set.' },
    wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'], description: 'Puppeteer navigation wait condition. Default networkidle2.' },
    wait_ms: { type: 'number', description: 'Extra wait after navigation and JavaScript, in milliseconds. Max 30000.' },
    viewport_width: { type: 'number', description: 'Viewport width. Default 1440.' },
    viewport_height: { type: 'number', description: 'Viewport height. Default 900.' },
    device_scale_factor: { type: 'number', description: 'Device scale factor. Default 1, max 3.' },
  },
  handler: async (args, ctx) => {
    try {
      const data = await callBrowserless(ctx, screenshotCode, {
        ...baseContext(args),
        selector: args.selector || '',
        full_page: Boolean(args.full_page),
      });
      const meta = { ...data };
      delete meta.screenshot_base64;
      return {
        content: [
          { type: 'text', text: JSON.stringify(meta, null, 2) },
          { type: 'image', data: data.screenshot_base64, mimeType: data.mime_type || 'image/png' },
        ],
      };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
});

app.tool('run_console_javascript', {
  description: 'Navigate to a web page and execute JavaScript as if pasted into DevTools Console. Returns the serialized result, console output, page errors, and optional screenshot.',
  parameters: {
    url: { type: 'string', description: 'HTTP or HTTPS URL to open.' },
    code: { type: 'string', description: 'JavaScript to evaluate in the page context. Expressions and async expressions work. For statement blocks, use return if you need a value.' },
    include_screenshot: { type: 'boolean', description: 'Include a viewport screenshot after running the code.' },
    wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'], description: 'Puppeteer navigation wait condition. Default networkidle2.' },
    wait_ms: { type: 'number', description: 'Extra wait after navigation, before running console code.' },
    viewport_width: { type: 'number', description: 'Viewport width. Default 1440.' },
    viewport_height: { type: 'number', description: 'Viewport height. Default 900.' },
  },
  handler: async (args, ctx) => {
    try {
      if (!String(args.code ?? '').trim()) throw new Error('code is required');
      const data = await callBrowserless(ctx, runConsoleCode, {
        ...baseContext(args),
        code: String(args.code),
        include_screenshot: Boolean(args.include_screenshot),
      });
      if (!data.screenshot_base64) return JSON.stringify(data, null, 2);
      const meta = { ...data };
      delete meta.screenshot_base64;
      return {
        content: [
          { type: 'text', text: JSON.stringify(meta, null, 2) },
          { type: 'image', data: data.screenshot_base64, mimeType: 'image/png' },
        ],
      };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
});

app.tool('automate_browser', {
  description: 'Run a trusted Puppeteer script against a Browserless page. Use for multi-step browsing, clicks, forms, custom extraction, screenshots, and debugging.',
  parameters: {
    script: { type: 'string', description: 'Async function body. Available variables: page, context, serialize. Example: await page.goto(context.url); return await page.title();' },
    script_context: { type: 'object', description: 'JSON object passed to the script as context.' },
    include_screenshot: { type: 'boolean', description: 'Include a screenshot after the script runs.' },
    full_page: { type: 'boolean', description: 'Capture full page when include_screenshot is true.' },
    viewport_width: { type: 'number', description: 'Viewport width. Default 1440.' },
    viewport_height: { type: 'number', description: 'Viewport height. Default 900.' },
  },
  handler: async (args, ctx) => {
    try {
      if (!String(args.script ?? '').trim()) throw new Error('script is required');
      const data = await callBrowserless(ctx, automateCode, {
        script: String(args.script),
        script_context: args.script_context || {},
        include_screenshot: Boolean(args.include_screenshot),
        full_page: Boolean(args.full_page),
        viewport: {
          width: Number(args.viewport_width || 1440),
          height: Number(args.viewport_height || 900),
          deviceScaleFactor: 1,
        },
      });
      if (!data.screenshot_base64) return JSON.stringify(data, null, 2);
      const meta = { ...data };
      delete meta.screenshot_base64;
      return {
        content: [
          { type: 'text', text: JSON.stringify(meta, null, 2) },
          { type: 'image', data: data.screenshot_base64, mimeType: 'image/png' },
        ],
      };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
});

export default app;
