/**
 * 참고: 이 모듈의 'optimize'는 이제 '읽어서 base64로 캐시한다'는 뜻이다.
 * 이미지 축소·재인코딩은 하지 않는다(네이티브 처리 모듈을 배포본에 싣지 않는다).
 * 함수 이름은 호출부 변경을 피하려고 그대로 뒀다.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';
import { getConfig, LiveShareConfig } from './config';

// Project root for security boundary (set by watcher.ts on session start)
let projectRoot: string | null = null;

export function setProjectRoot(root: string | null): void {
  projectRoot = root;
}

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
// 백그라운드 최적화가 끝나 새 이미지가 캐시된 뒤 호출되는 훅. watcher가 등록해
// 실시간 타이핑 중 처음 삽입된 이미지를 캐시 완료 시점에 재전송하도록 한다.
let onImagesOptimized: (() => void) | null = null;

export function setOnImagesOptimized(cb: (() => void) | null): void {
  onImagesOptimized = cb;
}

// Config cache - refreshed per call batch, not per image
let cachedConfig: LiveShareConfig | null = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 5000; // 5 seconds

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
 * When projectRoot is set, allows paths within the workspace root.
 * Otherwise falls back to baseDir (notebook/document directory) as boundary.
 */
function resolveImagePath(src: string, baseDir: string): string | null {
  try {
    const decoded = decodeURIComponent(src);
    const absPath = path.resolve(baseDir, decoded);
    const normalizedAbs = path.normalize(absPath);

    // Security: resolved path must be within the security boundary.
    // When projectRoot is set (workspace root), allow paths anywhere within the project.
    // Otherwise, fall back to baseDir (notebook directory) as the boundary.
    const securityRoot = projectRoot ?? baseDir;
    const normalizedRoot = path.normalize(securityRoot);
    if (normalizedAbs !== normalizedRoot && !normalizedAbs.startsWith(normalizedRoot + path.sep)) {
      Logger.warn(`Image path traversal blocked: ${src} (boundary: ${normalizedRoot})`);
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

    // 이미지는 원본 그대로 base64로 실어 보낸다. 축소·재인코딩은 하지 않는다.
    // (네이티브 이미지 처리 모듈은 배포본에 싣지 않는다. 예전에도 의존성 선언만
    //  있고 실제로는 배포되지 않아 이 경로는 항상 원본 전송으로 동작했다.)
    const buffer = fs.readFileSync(absPath);
    const resultBuffer: Buffer = buffer;
    const resultMime = mime;

    const base64 = resultBuffer.toString('base64');
    const base64SizeKB = Math.round((base64.length * 3) / 4 / 1024);
    if (base64SizeKB > config.imageMaxSizeKB) {
      Logger.warn(`Image exceeds imageMaxSizeKB and is sent as-is: ${absPath} (${base64SizeKB}KB > ${config.imageMaxSizeKB}KB)`);
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

  let anyCached = false;
  for (const absPath of paths) {
    try {
      await optimizeAndCache(absPath);
      anyCached = true;
    } catch (err) {
      Logger.warn(`Background optimize failed: ${absPath} - ${err}`);
    }
  }

  // 새로 캐시된 이미지가 있으면 watcher에 알려 해당 콘텐츠를 재전송하게 한다.
  // (재전송 시 full-resolve는 캐시 히트라 scheduleOptimize를 다시 부르지 않으므로 루프 없음.)
  if (anyCached && onImagesOptimized) {
    try { onImagesOptimized(); } catch (err) { Logger.warn(`onImagesOptimized hook failed: ${err}`); }
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
