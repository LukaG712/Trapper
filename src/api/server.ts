import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { apiKeyAuth } from './middleware/auth';
import { registerScrapeRoutes } from './routes/scrape';
import { registerCrawlRoutes } from './routes/crawl';
import { registerMapRoutes } from './routes/map';
import { registerBatchScrapeRoutes } from './routes/batchScrape';
import { registerSearchRoutes } from './routes/search';
import { registerInteractRoutes } from './routes/interact';
import { registerExtractRoutes } from './routes/extract';
import { registerAgentRoutes } from './routes/agent';
import config from '../config';
import logger from '../utils/logger';

const app = Fastify({
  logger: {
    level: config.logLevel,
  },
});

async function bootstrap() {
  // Register plugins
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    keyGenerator: (request) => {
      return request.headers.authorization || request.ip;
    },
  });

  // Health check (no auth required)
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Capabilities (no auth required)
  app.get('/api/capabilities', async () => {
    return {
      service: 'Trapper',
      version: '1.0.0',
      features: {
        scrape: {
          supported: true,
          description: 'Single page scraping with browser rendering',
        },
        crawl: {
          supported: true,
          description: 'Multi-page site crawling with depth control',
        },
        map: {
          supported: true,
          description: 'Site URL discovery and mapping',
        },
        batch_scrape: {
          supported: true,
          description: 'Batch scraping of multiple URLs',
        },
        search: {
          supported: true,
          description: 'Web search integration',
        },
        interact: {
          supported: true,
          description: 'Page interaction (clicks, form fills, etc.)',
        },
        extract: {
          supported: true,
          description: 'Structured data extraction',
        },
        agent: {
          supported: true,
          description: 'Autonomous research agent',
        },
        ssrf_protection: {
          supported: true,
          description: 'SSRF protection for private IPs and metadata endpoints',
        },
        rate_limiting: {
          supported: true,
          description: 'Rate limiting per API key',
        },
      },
      api_versions: ['v1'],
    };
  });

  // Register routes (before auth hook so health/capabilities are not protected)
  registerScrapeRoutes(app);
  registerCrawlRoutes(app);
  registerMapRoutes(app);
  registerBatchScrapeRoutes(app);
  registerSearchRoutes(app);
  registerInteractRoutes(app);
  registerExtractRoutes(app);
  registerAgentRoutes(app);

  // Apply auth to all API routes (skip health check and capabilities)
  app.addHook('onRequest', async (request, reply) => {
    // Skip auth for health check and capabilities endpoints
    if (request.url === '/health' || request.url === '/api/capabilities') {
      return;
    }
    await apiKeyAuth(request, reply, () => {});
  });

  // Error handler
  app.setErrorHandler((error, request, reply) => {
    logger.error(`Unhandled error: ${error.message}`);
    reply.code(500).send({
      success: false,
      error: 'Internal server error',
    });
  });

  return app;
}

export async function startServer() {
  await bootstrap();

  try {
    await app.listen({
      port: config.port,
      host: config.host,
    });
    logger.info(`Server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    logger.error(`Failed to start server: ${(err as Error).message}`);
    process.exit(1);
  }
}

export { app };
