import { InteractOptions, InteractResult, ScrapeData, ScrapeMetadata } from '../../utils/types';
import {
  getSession,
  createSession,
} from '../scrape/browser';
import { executeActions } from '../scrape/actions';
import { htmlToMarkdown, extractMetadata } from '../scrape/content';
import logger from '../../utils/logger';
import { Page } from 'playwright';

export async function interactWithPage(options: InteractOptions): Promise<InteractResult> {
  const { scrapeId, prompt, code, actions } = options;

  let sessionId = scrapeId;

  // If no session ID, create a new one
  if (!sessionId) {
    sessionId = await createSession();
    logger.info(`Created new session for interact: ${sessionId}`);
  }

  const session = await getSession(sessionId);
  if (!session) {
    return {
      success: false,
      error: `Session not found or expired: ${sessionId}`,
    };
  }

  const { page } = session;

  try {
    // If code is provided, execute it in the browser context.
    // WARNING: This executes arbitrary JavaScript in the page context.
    // The endpoint is protected by API key authentication.
    if (code) {
      try {
        const result = await page.evaluate((script) => {
          try {
            return eval(`(${script})`);
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
        }, code);
        logger.info(`Code execution result: ${JSON.stringify(result).slice(0, 200)}`);
      } catch (err) {
        logger.error(`Code execution failed: ${(err as Error).message}`);
        return {
          success: false,
          error: `Code execution failed: ${(err as Error).message}`,
          scrapeId: sessionId,
        };
      }
    }

    // If prompt is provided, try to interpret simple commands
    if (prompt) {
      await executePrompt(page, prompt);
    }

    // If actions are provided, execute them
    if (actions && actions.length > 0) {
      await executeActions(page, actions);
    }

    // Extract current page content
    const html = await page.content();
    const title = await page.title();
    const url = page.url();

    const markdown = htmlToMarkdown(html);
    const metadata: ScrapeMetadata = extractMetadata(html, url);
    metadata.title = title || metadata.title;

    const data: ScrapeData = {
      markdown,
      metadata,
    };

    logger.info(`Interact completed for session ${sessionId}`);

    return {
      success: true,
      data,
      scrapeId: sessionId,
    };
  } catch (err) {
    logger.error(`Interact failed for session ${sessionId}: ${(err as Error).message}`);
    return {
      success: false,
      error: `Interaction failed: ${(err as Error).message}`,
      scrapeId: sessionId,
    };
  }
}

async function executePrompt(page: Page, prompt: string): Promise<void> {
  // Simple prompt interpretation for common actions
  const promptLower = prompt.toLowerCase();

  // Click commands: "click #button", "click .submit"
  // Match against lowercase for command detection, but extract from original to preserve case
  const clickMatchLower = promptLower.match(/click\s+([^\s,]+)/);
  if (clickMatchLower) {
    const clickMatch = prompt.match(/click\s+([^\s,]+)/i);
    const selector = clickMatch ? clickMatch[1] : clickMatchLower[1];
    await page.click(selector).catch(() => {
      logger.warn(`Could not click selector: ${selector}`);
    });
    return;
  }

  // Type commands: "type Hello World"
  // Match against lowercase for command detection, but extract from original to preserve case
  const typeMatchLower = promptLower.match(/type\s+(.+)/);
  if (typeMatchLower) {
    const typeMatch = prompt.match(/type\s+(.+)/i);
    const text = typeMatch ? typeMatch[1] : typeMatchLower[1];
    await page.keyboard.type(text);
    return;
  }

  // Scroll commands: "scroll down", "scroll up"
  if (promptLower.includes('scroll down')) {
    await page.evaluate('window.scrollBy(0, window.innerHeight)');
    return;
  }
  if (promptLower.includes('scroll up')) {
    await page.evaluate('window.scrollBy(0, -window.innerHeight)');
    return;
  }

  // Wait command: "wait 2000"
  const waitMatch = promptLower.match(/wait\s+(\d+)/);
  if (waitMatch) {
    const ms = parseInt(waitMatch[1], 10);
    await page.waitForTimeout(ms);
    return;
  }

  // Press key: "press Enter"
  // Match against lowercase for command detection, but extract from original to preserve case
  const pressMatchLower = promptLower.match(/press\s+(\w+)/);
  if (pressMatchLower) {
    const pressMatch = prompt.match(/press\s+(\w+)/i);
    const key = pressMatch ? pressMatch[1] : pressMatchLower[1];
    await page.keyboard.press(key);
    return;
  }

  // Navigate: "go to https://example.com"
  const goMatch = prompt.match(/go\s+to\s+(\S+)/i);
  if (goMatch) {
    const url = goMatch[1];
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return;
  }

  logger.warn(`Unhandled prompt: ${prompt}`);
}
