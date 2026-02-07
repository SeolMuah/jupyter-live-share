import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';
import { getConfig, LiveShareConfig } from './config';

// Supported image extensions
const SUPPORTED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico',
]);

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

// Regex patterns for local image references
// Markdown: ![alt](path) or ![alt](path "title")
const MD_IMG_RE = /!\[([^\]]*)\]\(([^)]+?)(?:\s+"[^"]*")?\)/g;
// HTML: <img ... src="path" ... > (single or double quotes)
const HTML_IMG_RE = /<img\s+[^>]*?src\s*=\s*(['"])([^'"]+?)\1[^>]*?>/gi;

// Quick presence check - avoid expensive regex when no image patterns exist
const QUICK_MD_CHECK = /!\[/;
const QUICK_HTML_CHECK = /<img\s/i;

// Cache: absolute path -> { dataUri, mtime, lastAccess }
const imageCache = new Map<string, { dataUri: string; mtime: number; lastAccess: number }>();
const MAX_CACHE_ENTRIES = 100;

// Background optimization queue
const optimizeQueue = new Set<string>();
let optimizeTimer: NodeJS.Timeout | null = null;

// Config cache - refreshed per call batch, not per image
let cachedConfig: LiveShareConfig | null = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 5000; // 5 seconds

let sharpAvailable = false;
let sharpModule: any = null;
try {
  sharpModule = require('sharp');
  sharpAvailable = true;
} catch {
  Logger.warn('sharp not available - images will not be optimized');
}

/**
 * Get cached config (avoids repeated vscode.workspace.getConfiguration calls)
 */
function getCachedConfig(): LiveShareConfig {
  const now = Date.now();
  if (!cachedConfig || now - configCacheTime > CONFIG_CACHE_TTL) {
    cachedConfig = getConfig();
    configCacheTime = now;
  }
  return cachedConfig;
}

/**
 * Check if text contains any image patterns worth processing.
 * Fast O(n) scan avoids costly regex on text without images.
 */
export function hasImagePatterns(text: string): boolean {
  return QUICK_MD_CHECK.test(text) || QUICK_HTML_CHECK.test(text);
}

/**
 * Check if a src path is a local file reference (not URL, not data URI)
 */
function isLocalPath(src: string): boolean {
  if (src.startsWith('http://') || src.startsWith('https://')) return false;
  if (src.startsWith('data:')) return false;
  if (src.startsWith('//')) return false;
  return true;
}

/**
 * Resolve a local image path to an absolute path, with security checks.
 * Only allows paths within baseDir and its subdirectories.
 */
function resolveImagePath(src: string, baseDir: string): string | null {
  try {
    const decoded = decodeURIComponent(src);
    const absPath = path.resolve(baseDir, decoded);
    const normalizedAbs = path.normalize(absPath);

    // Security: resolved path must start with baseDir + separator
    // This allows baseDir/file.png and baseDir/sub/file.png
    // but blocks ../sibling/file.png and any other traversal
    const normalizedBase = path.normalize(baseDir);
    if (normalizedAbs !== normalizedBase && !normalizedAbs.startsWith(normalizedBase + path.sep)) {
      Logger.warn(`Image path traversal blocked: ${src}`);
      return null;
    }

    // Check extension
    const ext = path.extname(absPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) return null;

    // Check file exists
    if (!fs.existsSync(absPath)) return null;

    return absPath;
  } catch {
    return null;
  }
}

/**
 * Evict least-recently-accessed entries when cache exceeds limit.
 */
function evictCacheIfNeeded(): void {
  if (imageCache.size <= MAX_CACHE_ENTRIES) return;

  // Sort by lastAccess ascending, remove oldest entries
  const entries = Array.from(imageCache.entries())
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  const toRemove = entries.length - MAX_CACHE_ENTRIES;
  for (let i = 0; i < toRemove; i++) {
    imageCache.delete(entries[i][0]);
  }
}

/**
 * Read a local image and return a data URI (no optimization, sync).
 */
function readImageAsDataUri(absPath: string, config: LiveShareConfig): string | null {
  try {
    const ext = path.extname(absPath).toLowerCase();
    const mime = MIME_MAP[ext];
    if (!mime) return null;

    const stats = fs.statSync(absPath);

    // Skip if raw file is excessively large (4x max size as rough base64 headroom)
    if (stats.size > config.imageMaxSizeKB * 1024 * 4) {
      Logger.warn(`Image too large to embed: ${absPath} (${Math.round(stats.size / 1024)}KB)`);
      return null;
    }

    const buffer = fs.readFileSync(absPath);
    const base64 = buffer.toString('base64');
    return `data:${mime};base64,${base64}`;
  } catch (err) {
    Logger.warn(`Failed to read image: ${absPath} - ${err}`);
    return null;
  }
}

/**
 * Get data URI from cache only (no disk I/O).
 * Returns null on cache miss — caller should schedule background optimization.
 */
function getCacheOnly(absPath: string): string | null {
  const cached = imageCache.get(absPath);
  if (cached) {
    cached.lastAccess = Date.now();
    return cached.dataUri;
  }
  return null;
}

/**
 * Get cached data URI, or read from disk on cache miss (sync).
 * Used for full-sync events (notebook:full, document:full) where completeness matters.
 */
function getCachedOrRead(absPath: string, config: LiveShareConfig): string | null {
  try {
    const stats = fs.statSync(absPath);
    const mtime = stats.mtimeMs;
    const now = Date.now();
    const cached = imageCache.get(absPath);

    if (cached && cached.mtime === mtime) {
      cached.lastAccess = now;
      return cached.dataUri;
    }

    // Cache miss or file changed - read raw
    const dataUri = readImageAsDataUri(absPath, config);
    if (dataUri) {
      imageCache.set(absPath, { dataUri, mtime, lastAccess: now });
      evictCacheIfNeeded();
    }
    return dataUri;
  } catch {
    return null;
  }
}

/**
 * Replace image src using cache+disk (for full sync).
 */
function replaceImageSrcFull(src: string, baseDir: string, config: LiveShareConfig): string | null {
  if (!isLocalPath(src)) return null;
  const absPath = resolveImagePath(src, baseDir);
  if (!absPath) return null;
  return getCachedOrRead(absPath, config);
}

/**
 * Replace image src using cache only (for real-time typing).
 * Schedules background optimization on cache miss.
 */
function replaceImageSrcCacheOnly(src: string, baseDir: string): string | null {
  if (!isLocalPath(src)) return null;
  const absPath = resolveImagePath(src, baseDir);
  if (!absPath) return null;
  const cached = getCacheOnly(absPath);
  if (!cached) {
    // Schedule background optimize+cache for next time
    scheduleOptimize(absPath);
  }
  return cached;
}

/**
 * Core replacement logic using the given replacer function.
 */
function replaceImages(
  text: string,
  replacer: (src: string) => string | null
): string {
  // Replace Markdown images: ![alt](path)
  let result = text.replace(MD_IMG_RE, (match, alt, src) => {
    const dataUri = replacer(src.trim());
    if (!dataUri) return match;
    return `![${alt}](${dataUri})`;
  });

  // Replace HTML images: <img src="path">
  result = result.replace(HTML_IMG_RE, (match, quote, src) => {
    const dataUri = replacer(src.trim());
    if (!dataUri) return match;
    return match.replace(`${quote}${src}${quote}`, `${quote}${dataUri}${quote}`);
  });

  return result;
}

/**
 * Resolve local images for full-sync events (notebook:full, document:full, new viewer).
 * Reads from cache or disk. Guarantees all resolvable images are embedded.
 */
export function resolveLocalImages(text: string, baseDir: string): string {
  if (!text || !baseDir || !hasImagePatterns(text)) return text;
  const config = getCachedConfig();
  return replaceImages(text, (src) => replaceImageSrcFull(src, baseDir, config));
}

/**
 * Resolve local images for real-time typing events (cell:update, document:update).
 * Uses cache only — never blocks on disk I/O. Cache misses are skipped and
 * queued for background optimization.
 */
export function resolveLocalImagesCacheOnly(text: string, baseDir: string): string {
  if (!text || !baseDir || !hasImagePatterns(text)) return text;
  return replaceImages(text, (src) => replaceImageSrcCacheOnly(src, baseDir));
}

/**
 * Collect all local image absolute paths found in text.
 */
function collectImagePaths(text: string, baseDir: string): Set<string> {
  const paths = new Set<string>();

  let match;
  const mdRe = new RegExp(MD_IMG_RE.source, MD_IMG_RE.flags);
  while ((match = mdRe.exec(text)) !== null) {
    const src = match[2].trim();
    if (isLocalPath(src)) {
      const absPath = resolveImagePath(src, baseDir);
      if (absPath) paths.add(absPath);
    }
  }

  const htmlRe = new RegExp(HTML_IMG_RE.source, HTML_IMG_RE.flags);
  while ((match = htmlRe.exec(text)) !== null) {
    const src = match[2].trim();
    if (isLocalPath(src)) {
      const absPath = resolveImagePath(src, baseDir);
      if (absPath) paths.add(absPath);
    }
  }

  return paths;
}

/**
 * Pre-optimize images found in text and store in cache.
 * Call with the ORIGINAL text (before resolveLocalImages) at session start or file switch.
 * Returns a promise that resolves when all images are cached.
 */
export async function preOptimizeImages(text: string, baseDir: string): Promise<void> {
  if (!text || !baseDir || !hasImagePatterns(text)) return;

  const paths = collectImagePaths(text, baseDir);
  for (const absPath of paths) {
    await optimizeAndCache(absPath);
  }
}

/**
 * Optimize a single image and store in cache.
 */
async function optimizeAndCache(absPath: string): Promise<void> {
  try {
    const stats = fs.statSync(absPath);
    const mtime = stats.mtimeMs;
    const cached = imageCache.get(absPath);

    // Already cached and up-to-date
    if (cached && cached.mtime === mtime) return;

    const config = getCachedConfig();
    const ext = path.extname(absPath).toLowerCase();
    const mime = MIME_MAP[ext];
    if (!mime) return;

    const buffer = fs.readFileSync(absPath);
    const OPTIMIZE_THRESHOLD = 200 * 1024; // 200KB

    let resultBuffer: Buffer = buffer;
    let resultMime = mime;

    // Only optimize if sharp is available and file is large enough
    if (sharpAvailable && buffer.length >= OPTIMIZE_THRESHOLD) {
      try {
        resultBuffer = Buffer.from(await optimizeWithSharp(buffer, ext, config.imageMaxWidth));
        // Update MIME if format changed (PNG->JPEG)
        if (ext === '.png' && resultBuffer[0] === 0xFF && resultBuffer[1] === 0xD8) {
          resultMime = 'image/jpeg';
        }
        // BMP -> JPEG
        if (ext === '.bmp') {
          resultMime = 'image/jpeg';
        }
      } catch (err) {
        Logger.warn(`sharp optimization failed for ${absPath}: ${err}`);
        // Fall through with original buffer
      }
    }

    // Final size check
    const base64 = resultBuffer.toString('base64');
    const base64SizeKB = Math.round((base64.length * 3) / 4 / 1024);
    if (base64SizeKB > config.imageMaxSizeKB) {
      Logger.warn(`Image still too large after optimization: ${absPath} (${base64SizeKB}KB > ${config.imageMaxSizeKB}KB)`);
    }

    const now = Date.now();
    const dataUri = `data:${resultMime};base64,${base64}`;
    imageCache.set(absPath, { dataUri, mtime, lastAccess: now });
    evictCacheIfNeeded();
    Logger.info(`Image cached: ${path.basename(absPath)} (${Math.round(buffer.length / 1024)}KB -> ${base64SizeKB}KB base64)`);
  } catch (err) {
    Logger.warn(`Failed to optimize image: ${absPath} - ${err}`);
  }
}

/**
 * Optimize image buffer using sharp.
 */
async function optimizeWithSharp(buffer: Buffer, ext: string, maxWidth: number): Promise<Buffer> {
  if (!sharpModule) return buffer;

  // GIF and SVG: no optimization (sharp can't handle animated GIFs well, SVG should stay as-is)
  if (ext === '.gif' || ext === '.svg') return buffer;

  // Use a single pipeline: read metadata first, then chain operations
  let pipeline = sharpModule(buffer);
  const metadata = await pipeline.metadata();

  // After metadata(), the pipeline is consumed — create a new one for processing
  pipeline = sharpModule(buffer);
  if (metadata.width && metadata.width > maxWidth) {
    pipeline = pipeline.resize(maxWidth, null, { fit: 'inside', withoutEnlargement: true });
  }

  // Format-specific optimization
  if (ext === '.png') {
    if (metadata.hasAlpha) {
      return pipeline.png({ compressionLevel: 8, quality: 80 }).toBuffer();
    } else {
      return pipeline.jpeg({ quality: 80 }).toBuffer();
    }
  } else if (ext === '.jpg' || ext === '.jpeg') {
    return pipeline.jpeg({ quality: 80 }).toBuffer();
  } else if (ext === '.webp') {
    return pipeline.webp({ quality: 80 }).toBuffer();
  } else if (ext === '.bmp') {
    return pipeline.jpeg({ quality: 80 }).toBuffer();
  }

  return buffer;
}

/**
 * Schedule background optimization for an image path.
 * Batches multiple paths into a single async run.
 */
function scheduleOptimize(absPath: string): void {
  optimizeQueue.add(absPath);
  if (!optimizeTimer) {
    optimizeTimer = setTimeout(processOptimizeQueue, 100);
  }
}

async function processOptimizeQueue(): Promise<void> {
  optimizeTimer = null;
  const paths = Array.from(optimizeQueue);
  optimizeQueue.clear();

  for (const absPath of paths) {
    try {
      await optimizeAndCache(absPath);
    } catch (err) {
      Logger.warn(`Background optimize failed: ${absPath} - ${err}`);
    }
  }
}

/**
 * Clear image cache (call on session end).
 */
export function clearImageCache(): void {
  imageCache.clear();
  optimizeQueue.clear();
  if (optimizeTimer) {
    clearTimeout(optimizeTimer);
    optimizeTimer = null;
  }
  cachedConfig = null;
  Logger.info('Image cache cleared');
}
