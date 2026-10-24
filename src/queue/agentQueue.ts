import { Queue, Job } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { getRedisClient } from '../database/redis';
import logger from '../utils/logger';
import { AgentOptions, AgentJob } from '../utils/types';

const AGENT_QUEUE_NAME = 'agent-queue';

let agentQueue: Queue | null = null;

export function getAgentQueue(): Queue {
  if (!agentQueue) {
    const connection = getRedisClient();
    agentQueue = new Queue(AGENT_QUEUE_NAME, { connection });
    logger.info('Agent queue initialized');
  }
  return agentQueue;
}

export async function createAgentJob(options: AgentOptions): Promise<string> {
  const queue = getAgentQueue();
  const jobId = uuidv4();

  await queue.add('agent', options, {
    jobId,
    attempts: 3,
  });

  logger.info(`Created agent job: ${jobId}`);
  return jobId;
}

export async function getAgentJobStatus(jobId: string): Promise<AgentJob | null> {
  const queue = getAgentQueue();
  const job = await queue.getJob(jobId);

  if (!job) {
    return null;
  }

  const jobData = job.data as any;
  const jobProgress = job.progress as any;

  const agentJob: AgentJob = {
    jobId,
    status: jobProgress?.status || 'running',
    options: jobData.options || { prompt: '' },
    result: jobData.result,
    error: jobData.error,
    sources: jobData.sources,
    createdAt: new Date(job.timestamp || Date.now()).toISOString(),
    completedAt: jobData.completedAt,
  };

  return agentJob;
}

export async function deleteAgentJob(jobId: string): Promise<void> {
  const queue = getAgentQueue();
  const job = await queue.getJob(jobId);
  if (job) {
    await job.remove();
    logger.info(`Deleted agent job: ${jobId}`);
  }
}
