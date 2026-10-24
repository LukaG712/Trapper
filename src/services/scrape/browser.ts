import { chromium, Browser, BrowserContext, Page } from 'playwright';
import config from '../../config';
import logger from '../../utils/logger';
import { Action } from '../../utils/types';
import { executeActions, ActionsResult } from './actions';

let browser: Browser | null = null;

// Session storage for /interact endpoint
interface BrowserSession {
  context: BrowserContext;
  page: Page;
  createdAt: number;
}

const sessions = new Map<string, BrowserSession>();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Periodic cleanup of expired sessions (every 5 minutes)
let cleanupTimer: NodeJS.Timeout | null = null;

export function startSessionCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    await cleanupExpiredSessions();
  }, 5 * 60 * 1000);
  cleanupTimer.unref?.(); // Don't keep process alive
  logger.info('Session cleanup timer started');
}

export function stopSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    logger.info('Session cleanup timer stopped');
  }
}

export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      headless: config.browser.headless,
      timeout: config.browser.launchTimeout,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
      ],
    });
    logger.info('Browser launched');
  }
  return browser;
}

export async function getContext(options?: { mobile?: boolean }): Promise<BrowserContext> {
  // Create a new isolated context for each call to prevent cookie/state leakage
  const brow = await getBrowser();
  const viewport = options?.mobile
    ? { width: 375, height: 812 }
    : { width: 1280, height: 800 };

  return await brow.newContext({
    userAgent: options?.mobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport,
  });
}

export interface BrowserScrapeOptions {
  waitFor?: number;
  timeout?: number;
  headers?: Record<string, string>;
  blockAds?: boolean;
  screenshot?: boolean;
  mobile?: boolean;
  actions?: Action[];
}

export async function scrapeWithBrowser(
  url: string,
  options: BrowserScrapeOptions = {}
): Promise<{ html: string; title: string; screenshot?: string; statusCode?: number; actionsResult?: ActionsResult }> {
  const context = await getContext({ mobile: options.mobile });
  const page: Page = await context.newPage();

  try {
    const timeout = options.timeout || config.scrape.timeout;

    if (options.headers) {
      await page.setExtraHTTPHeaders(options.headers);
    }

    if (options.mobile) {
      await page.setViewportSize({ width: 375, height: 812 });
    }

    if (options.blockAds) {
      await page.route('**/*', async (route) => {
        const reqUrl = route.request().url();
        const adPatterns = [
          '/ads/',
          'doubleclick.net',
          'adservice.',
          'googlesyndication.com',
          'adsbygoogle',
          'facebook.com/plugins',
          '.facebook.com/tr/',
          'connect.facebook.net',
        ];
        if (adPatterns.some((p) => reqUrl.toLowerCase().includes(p))) {
          await route.abort();
          return;
        }
        await route.continue();
      });
    }

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout,
    });

    // Smart wait: wait for network to be idle if no explicit waitFor
    if (!options.waitFor || options.waitFor === 0) {
      try {
        await page.waitForLoadState('networkidle', { timeout: 5000 });
      } catch {
        // Network may never be fully idle; continue anyway
      }
    }

    // Wait for additional time if requested
    if (options.waitFor && options.waitFor > 0) {
      await page.waitForTimeout(options.waitFor);
    }

    const html = await page.content();
    const title = await page.title();

    let screenshot: string | undefined;
    if (options.screenshot) {
      const buf = await page.screenshot({
        type: 'png',
        fullPage: true,
      });
      // Convert to base64
      screenshot = buf.toString('base64');
    }

    // Execute actions if provided
    let actionsResult: ActionsResult | undefined;
    let finalHtml = html;
    let finalTitle = title;
    if (options.actions && options.actions.length > 0) {
      actionsResult = await executeActions(page, options.actions);
      // Re-extract HTML after actions may have changed the page
      finalHtml = await page.content();
      finalTitle = await page.title();
    }

    const statusCode = response?.status();
    logger.info(`Browser scrape completed for ${url}, status: ${statusCode}`);

    return { html: finalHtml, title: finalTitle, screenshot, statusCode, actionsResult };
  } finally {
    await page.close();
  }
}

// Session management for /interact endpoint
export async function createSession(options?: { mobile?: boolean }): Promise<string> {
  const context = await getContext({ mobile: options?.mobile });
  const page = await context.newPage();
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { context, page, createdAt: Date.now() });
  logger.info(`Created browser session: ${sessionId}`);
  return sessionId;
}

export async function getSession(sessionId: string): Promise<BrowserSession | null> {
  const session = sessions.get(sessionId);
  if (!session) return null;

  // Check if session has timed out
  if (Date.now() - session.createdAt > SESSION_TIMEOUT_MS) {
    await session.page.close();
    await session.context.close();
    sessions.delete(sessionId);
    return null;
  }

  // Reset timeout on access
  session.createdAt = Date.now();
  return session;
}

export async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (session) {
    await session.page.close();
    await session.context.close();
    sessions.delete(sessionId);
    logger.info(`Closed browser session: ${sessionId}`);
  }
}

export async function cleanupExpiredSessions(): Promise<void> {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TIMEOUT_MS) {
      await session.page.close().catch(() => {});
      await session.context.close().catch(() => {});
      sessions.delete(id);
    }
  }
}

export async function closeBrowser(): Promise<void> {
  stopSessionCleanup();
  // Close all sessions
  for (const [id, session] of sessions.entries()) {
    await session.page.close().catch(() => {});
    await session.context.close().catch(() => {});
    sessions.delete(id);
  }

  if (browser) {
    await browser.close();
    browser = null;
    logger.info('Browser closed');
  }
}

