import path from 'path';
import { fileURLToPath } from 'url';

const thisFile = fileURLToPath(import.meta.url);
const srcDir = path.dirname(thisFile);
const repoRoot = path.resolve(srcDir, '..');

const appRoot = process.env.APP_ROOT || repoRoot;
const dataDir = process.env.DATA_DIR || path.join(appRoot, 'data');
const configDir = process.env.CONFIG_DIR || path.join(appRoot, 'config');
const publicDir = process.env.PUBLIC_DIR || path.join(appRoot, 'public');
const logDir = process.env.LOG_DIR || path.join(dataDir, 'logs');
// Default to a writable, repo-local directory to avoid permission issues.
const mediaDir = process.env.MEDIA_DIR || path.join(dataDir, 'media');

export const paths = {
  appRoot,
  dataDir,
  configDir,
  publicDir,
  logDir,
  mediaDir
};
