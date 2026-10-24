import https from 'https';
import http from 'http';
import zlib from 'zlib';
import { ScrapeOptions, ScrapeResult, ScrapeData, ScrapeMetadata, ScrapeFormat, JsonFormatOptions, Action } from '../../utils/types';
import { htmlToMarkdown, extractMetadata, extractLinks, cleanHtml, extractBranding } from './content';
import { scrapeWithBrowser } from './browser';
import { isBlockedUrl } from '../../utils/ssrfProtection';
import logger from '../../utils/logger';
import config from '../../config';

interface FetchResult {
  html: string;
  statusCode: number;
  headers?: Record<string, string>;
}

function fetchHtml(
  url: string,
  options: { timeout?: number; headers?: Record<string, string>; skipTlsVerification?: boolean; maxRetries?: number }
): Promise<FetchResult> {
  const maxRetries = options.maxRetries ?? 2;

  return new Promise(async (resolve, reject) => {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.info(`Retry ${attempt}/${maxRetries} for ${url} after ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        const timeout = options.timeout || config.scrape.timeout;

        const agentOptions = options.skipTlsVerification
          ? { rejectUnauthorized: false }
          : {};

        const parsedUrl = new URL(url);
        const isHttps = parsedUrl.protocol === 'https:';

        const agent = isHttps
          ? new https.Agent(agentOptions)
          : new http.Agent();

        const reqOptions = {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            ...options.headers,
          },
          agent,
          timeout,
        };

        const result = await new Promise<FetchResult>((res, rej) => {
          const req = (isHttps ? https : http).request(url, reqOptions, (response) => {
            const chunks: Buffer[] = [];
            const respHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(response.headers)) {
              if (typeof value === 'string') {
                respHeaders[key] = value;
              }
            }
            const encoding = response.headers['content-encoding'];
            const decompress = encoding === 'gzip' ? zlib.createGunzip() :
                               encoding === 'br' ? zlib.createBrotliDecompress() :
                               encoding === 'deflate' ? zlib.createInflate() : null;
            if (decompress) {
              response.pipe(decompress);
              decompress.on('data', (chunk: Buffer) => chunks.push(chunk));
              decompress.on('end', () => {
                const html = Buffer.concat(chunks).toString('utf-8');
                res({ html, statusCode: response.statusCode || 200, headers: respHeaders });
              });
              decompress.on('error', (err) => {
                rej(new Error(`Decompression failed: ${err.message}`));
              });
            } else {
              response.on('data', (chunk: Buffer) => chunks.push(chunk));
              response.on('end', () => {
                const html = Buffer.concat(chunks).toString('utf-8');
                res({ html, statusCode: response.statusCode || 200, headers: respHeaders });
              });
            }
          });

          req.on('error', (err) => {
            rej(new Error(`Fetch failed: ${err.message}`));
          });

          req.on('timeout', () => {
            req.destroy();
            rej(new Error(`Request timed out after ${timeout}ms`));
          });

          req.end();
        });

        // Success - resolve
        resolve(result);
        return;
      } catch (err) {
        lastError = err as Error;
        logger.warn(`Fetch attempt ${attempt + 1} failed for ${url}: ${(err as Error).message}`);
      }
    }

    reject(lastError || new Error('All retries exhausted'));
  });
}

function isJsonFormat(format: ScrapeFormat): format is JsonFormatOptions {
  return typeof format === 'object' && format !== null && 'type' in format && format.type === 'json';
}

function getFormatString(format: ScrapeFormat): string {
  if (isJsonFormat(format)) return 'json';
  return format;
}

// Simple LLM-based JSON extraction using available content
async function extractJsonFromContent(
  markdown: string,
  options: JsonFormatOptions
): Promise<Record<string, unknown>> {
  // If no schema and no prompt, return empty
  if (!options.schema && !options.prompt) {
    return {};
  }

  // Check if we have an LLM provider configured
  const llmProvider = config.llm?.provider;
  if (!llmProvider) {
    logger.warn('JSON extraction requested but no LLM provider configured. Returning empty result.');
    return {};
  }

  try {
    // Build extraction prompt
    const prompt = options.prompt
      ? `Extract the following information from the page content: ${options.prompt}`
      : 'Extract structured data from the page content based on the provided schema.';

    const systemPrompt = `You are a data extraction assistant. ${prompt} Return only valid JSON matching the schema.`;

    // Call LLM provider
    const result = await callLlmProvider(llmProvider, systemPrompt, markdown, options.schema);
    return result;
  } catch (err) {
    logger.error(`JSON extraction failed: ${(err as Error).message}`);
    return {};
  }
}

async function callLlmProvider(
  provider: string,
  systemPrompt: string,
  content: string,
  schema?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  // Truncate content if too long
  const maxTokens = 6000;
  const truncatedContent = content.length > maxTokens * 4 ? content.slice(0, maxTokens * 4) : content;

  if (provider === 'openai') {
    return callOpenAI(systemPrompt, truncatedContent, schema);
  }

  // For other providers, return empty with warning
  logger.warn(`LLM provider '${provider}' not yet implemented. Supported: openai`);
  return {};
}

async function callOpenAI(
  systemPrompt: string,
  content: string,
  schema?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OpenAI API key not configured');
    return {};
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const userMessage = `Here is the webpage content to extract data from:\n\n${content}`;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0,
  };

  if (schema) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'extraction', schema } };
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  const message = (result as any).choices?.[0]?.message;
  if (!message) {
    throw new Error('No response from OpenAI');
  }

  // Parse JSON from response
  if (typeof message.content === 'string') {
    try {
      return JSON.parse(message.content);
    } catch {
      logger.warn('Failed to parse OpenAI response as JSON');
      return {};
    }
  }

  return {};
}

export async function scrapeUrl(options: ScrapeOptions): Promise<ScrapeResult> {
  const {
    url,
    formats = ['markdown'],
    onlyMainContent = config.scrape.onlyMainContent,
    onlyCleanContent = false,
    includeTags,
    excludeTags,
    waitFor = config.scrape.waitFor,
    timeout = config.scrape.timeout,
    headers,
    skipTlsVerification = false,
    blockAds = config.scrape.blockAds,
    removeBase64Images = false,
    mobile = false,
    parsePDF = false,
    actions,
  } = options;

  // SSRF protection: block requests to private/reserved addresses
  if (await isBlockedUrl(url)) {
    logger.warn(`SSRF blocked: request to ${url} denied`);
    return {
      success: false,
      error: `Request blocked: URL points to a private or reserved address (SSRF protection)`,
    };
  }

  logger.info(`Scraping URL: ${url}`);

  // Check if URL is a PDF
  const isPdf = url.toLowerCase().endsWith('.pdf') || parsePDF;

  let html: string;
  let statusCode: number;
  let titleFromBrowser = '';
  let screenshot: string | undefined;
  let responseHeaders: Record<string, string> | undefined;
  let actionsResult: { screenshots?: string[]; scrapes?: string[]; javascriptReturns?: unknown[] } | undefined;

  try {
    // Try simple HTTP fetch first
    const fetchResult = await fetchHtml(url, { timeout, headers, skipTlsVerification });
    html = fetchResult.html;
    statusCode = fetchResult.statusCode;
    responseHeaders = fetchResult.headers;

    // Handle PDF content
    if (isPdf || (responseHeaders?.['content-type']?.includes('application/pdf'))) {
      logger.info(`Detected PDF content, extracting text`);
      // For PDFs, we'll use the browser to render and extract text
      const browserResult = await scrapeWithBrowser(url, {
        waitFor,
        timeout,
        headers,
        blockAds,
        screenshot: formats.some((f) => getFormatString(f) === 'screenshot'),
        mobile,
      });
      html = browserResult.html;
      titleFromBrowser = browserResult.title;
      if (browserResult.screenshot) {
        screenshot = browserResult.screenshot;
      }
    }

    // If the HTML looks empty or like a JS app shell, fall back to browser
    const hasContent = html.length > 500 && !html.includes('<div id="root"></div>');
    const needsScreenshot = formats.some((f) => getFormatString(f) === 'screenshot');
    const needsMobile = mobile;
    const needsActions = actions && actions.length > 0;

    if ((!hasContent && waitFor === 0) || needsScreenshot || needsMobile || needsActions) {
      logger.info(`Using browser for ${url} (content: ${hasContent}, screenshot: ${needsScreenshot}, mobile: ${needsMobile}, actions: ${needsActions})`);
      const browserResult = await scrapeWithBrowser(url, {
        waitFor,
        timeout,
        headers,
        blockAds,
        screenshot: needsScreenshot,
        mobile,
        actions,
      });
      html = browserResult.html;
      titleFromBrowser = browserResult.title;
      if (browserResult.screenshot) {
        screenshot = browserResult.screenshot;
      }
      if (browserResult.statusCode) {
        statusCode = browserResult.statusCode;
      }
      if (browserResult.actionsResult) {
        actionsResult = browserResult.actionsResult;
      }
    }
  } catch (err) {
    logger.warn(`HTTP fetch failed for ${url}, trying browser: ${(err as Error).message}`);
    try {
      const browserResult = await scrapeWithBrowser(url, {
        waitFor,
        timeout,
        headers,
        blockAds,
        screenshot: formats.some((f) => getFormatString(f) === 'screenshot'),
        mobile,
        actions,
      });
      html = browserResult.html;
      titleFromBrowser = browserResult.title;
      if (browserResult.screenshot) {
        screenshot = browserResult.screenshot;
      }
      statusCode = browserResult.statusCode || 200;
      if (browserResult.actionsResult) {
        actionsResult = browserResult.actionsResult;
      }
    } catch (browserErr) {
      return {
        success: false,
        error: `Failed to scrape URL: ${(browserErr as Error).message}`,
      };
    }
  }

  // Clean HTML if requested
  let processedHtml = html;
  if (onlyMainContent || onlyCleanContent || includeTags || excludeTags) {
    processedHtml = cleanHtml(html, {
      onlyMainContent,
      onlyCleanContent,
      includeTags,
      excludeTags,
    });
  }

  // Extract metadata
  const metadata: ScrapeMetadata = extractMetadata(html, url, responseHeaders);
  if (titleFromBrowser && !metadata.title) {
    metadata.title = titleFromBrowser;
  }
  metadata.statusCode = statusCode;
  metadata.createdAt = new Date().toISOString();

  // Build result data
  const data: ScrapeData = {
    metadata,
  };

  // Include actions results if any
  if (actionsResult) {
    data.actions = actionsResult;
  }

  // Process each requested format
  for (const format of formats) {
    const formatStr = getFormatString(format);

    if (formatStr === 'markdown') {
      data.markdown = htmlToMarkdown(processedHtml);
      if (removeBase64Images && data.markdown) {
        data.markdown = data.markdown.replace(/!\[.*?\]\(data:[^\)]+\)/g, '');
      }
    }

    if (formatStr === 'html') {
      data.html = processedHtml;
    }

    if (formatStr === 'raw') {
      data.raw = html;
    }

    if (formatStr === 'links') {
      data.links = extractLinks(html, url);
    }

    if (formatStr === 'screenshot') {
      if (!screenshot) {
        // Take screenshot now if not already done
        const browserResult = await scrapeWithBrowser(url, {
          waitFor,
          timeout,
          headers,
          blockAds,
          screenshot: true,
          mobile,
        });
        screenshot = browserResult.screenshot;
      }
      data.screenshot = screenshot;
    }

    if (formatStr === 'branded') {
      data.branded = extractBranding(html);
    }

    if (formatStr === 'json' && isJsonFormat(format)) {
      // Need markdown content for JSON extraction
      const markdown = data.markdown || htmlToMarkdown(processedHtml);
      data.json = await extractJsonFromContent(markdown, format);
    }
  }

  logger.info(`Successfully scraped ${url}`);

  return {
    success: true,
    data,
  };
}
