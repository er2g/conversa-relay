import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { paths } from './paths.js';

fs.mkdirSync(paths.logDir, { recursive: true });

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      let metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
      return `${timestamp} [${level.toUpperCase()}] ${message} ${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          let metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
          return `${timestamp} [${level}] ${message} ${metaStr}`;
        })
      )
    }),
    new winston.transports.File({
      filename: path.join(paths.logDir, 'error.log'),
      level: 'error'
    }),
    new winston.transports.File({
      filename: path.join(paths.logDir, 'combined.log')
    })
  ]
});

export default logger;
