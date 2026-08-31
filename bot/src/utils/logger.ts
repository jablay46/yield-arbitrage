import winston from 'winston';

export function createLogger(level: string = 'info'): winston.Logger {
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} [${level}] ${message}${extra}`;
      })
    ),
    transports: [new winston.transports.Console()],
  });
}

export type Logger = winston.Logger;
