import { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { timingSafeEqual } from 'crypto';
import config from '../../config';

export async function apiKeyAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({
      success: false,
      error: 'Missing or invalid Authorization header. Use: Authorization: Bearer <key>',
    });
    return;
  }

  const providedKey = authHeader.slice(7);

  // Use constant-time comparison to prevent timing attacks
  try {
    const a = Buffer.from(providedKey);
    const b = Buffer.from(config.apiKey);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      reply.code(401).send({
        success: false,
        error: 'Invalid API key',
      });
      return;
    }
  } catch {
    reply.code(401).send({
      success: false,
      error: 'Invalid API key',
    });
    return;
  }

  done();
}
