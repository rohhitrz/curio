import { LangfuseClient } from '@langfuse/client';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { propagateAttributes, startActiveObservation } from '@langfuse/tracing';
import { LangfuseVercelAiSdkIntegration } from '@langfuse/vercel-ai-sdk';
import { NodeSDK, type tracing } from '@opentelemetry/sdk-node';
import { registerTelemetry } from 'ai';
import { truncateForTrace } from './truncate.js';
import type { Tracer } from './types.js';

export interface LangfuseTracerConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  /** `production`, `development`… shown on every trace. */
  environment: string;
  /** Strings in traces are cut to this length (privacy: no full source text). */
  maxTextChars: number;
  /**
   * `immediate` on serverless, where the process can freeze right after the response;
   * `batched` for a long-running process.
   */
  exportMode: 'immediate' | 'batched';
  /** Tests: capture spans instead of sending them. */
  exporter?: tracing.SpanExporter;
  /** Tests: capture scores instead of sending them. */
  scores?: Pick<LangfuseClient['score'], 'create' | 'flush'>;
}

export interface LangfuseTracing {
  tracer: Tracer;
  /** Flushes and stops tracing (process exit, end of a test file). */
  shutdown: () => Promise<void>;
}

/**
 * Cuts every string attribute before export. Langfuse's own `mask` only sees its input/output
 * attributes, while the AI SDK puts the whole prompt (with source chunks) in `gen_ai.*` ones.
 * Runs before the exporting processor, which reads the attributes on span end.
 */
function truncatingProcessor(truncate: (data: unknown) => unknown): tracing.SpanProcessor {
  return {
    onStart: () => undefined,
    onEnd(span) {
      const attributes = span.attributes as Record<string, unknown>;
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value === 'string') attributes[key] = truncate(value);
      }
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts OpenTelemetry with the Langfuse exporter and registers the AI SDK integration, both
 * process-wide, so call it once at startup.
 */
export function startLangfuseTracing(config: LangfuseTracerConfig): LangfuseTracing {
  const truncate = (data: unknown) => truncateForTrace(data, config.maxTextChars);
  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    environment: config.environment,
    exportMode: config.exportMode,
    ...(config.exporter ? { exporter: config.exporter } : {}),
  });
  const sdk = new NodeSDK({ spanProcessors: [truncatingProcessor(truncate), processor] });
  sdk.start();
  registerTelemetry(new LangfuseVercelAiSdkIntegration());

  const scores =
    config.scores ??
    new LangfuseClient({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
    }).score;

  const tracer: Tracer = {
    trace(options, fn) {
      return propagateAttributes(
        {
          traceName: options.name,
          userId: options.userId,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options.metadata ? { metadata: options.metadata } : {}),
        },
        () =>
          startActiveObservation(options.name, async (observation) => {
            observation.update({ input: options.input });
            try {
              return await fn({
                traceId: observation.traceId,
                setOutput: (output) => observation.update({ output }),
              });
            } catch (error) {
              observation.update({ level: 'ERROR', statusMessage: errorMessage(error) });
              throw error;
            }
          }),
      );
    },

    span(name, input, fn, output) {
      return startActiveObservation(name, async (observation) => {
        observation.update({ input });
        try {
          const result = await fn();
          observation.update({ output: output ? output(result) : result });
          return result;
        } catch (error) {
          observation.update({ level: 'ERROR', statusMessage: errorMessage(error) });
          throw error;
        }
      });
    },

    async score(score) {
      scores.create({
        ...(score.id ? { id: score.id } : {}),
        traceId: score.traceId,
        name: score.name,
        value: score.value,
        ...(score.comment ? { comment: score.comment } : {}),
      });
      await scores.flush();
    },

    async flush() {
      await Promise.all([processor.forceFlush(), scores.flush()]);
    },
  };

  return {
    tracer,
    shutdown: async () => {
      await tracer.flush();
      await sdk.shutdown();
    },
  };
}
