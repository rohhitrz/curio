import { pino, type Logger, type LoggerOptions } from 'pino';

export function createLogger(options: { level: string; pretty: boolean }): Logger {
  const config: LoggerOptions = {
    level: options.level,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  };
  if (options.pretty) {
    config.transport = { target: 'pino-pretty', options: { colorize: true } };
  }
  return pino(config);
}
