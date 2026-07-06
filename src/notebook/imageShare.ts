import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from '../utils/config';
import { Logger } from '../utils/logger';

/**
 * 단일 이미지 파일 공유 페이로드 빌더 (image:full 이벤트).
 * 대용량 처리 원칙:
 *  - sharp로 EXIF 회전 반영 + 최대폭 축소(기본 1600px, 레티나 대응) + 재인코딩
 *    (알파 없으면 JPEG q82/mozjpeg, 알파 있으면 WebP)
 *  - 결과가 imageMaxSizeKB(기본 2048KB)를 넘으면 폭 0.7배·품질 -12씩 최대 4회 단계 축소
 *  - 그래도 절대 상한(5MB)을 넘으면 전송하지 않고 에러 플레이스홀더 (WS 폭주 방지)
 *  - GIF는 애니메이션 보존을 위해 상한 이하면 원본 그대로, 초과 시 첫 프레임 정적 변환
 *  - SVG는 텍스트 그대로(1MB 제한) — 뷰어가 <img>로만 렌더하므로 스크립트 실행 불가
 *  - 다운로드 버튼은 항상 '원본 파일'을 제공 (httpServer /download가 디스크에서 읽음)
 */

export interface ImageFullPayload {
  fileName: string;
  filePath: string;
  mime?: string;
  /** data URI (base64) — error 시 없음 */
  data?: string;
  width?: number;
  height?: number;
  /** 원본 파일 크기 (표시용) */
  originalBytes?: number;
  error?: string;
}

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

export function getImageMime(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] || 'application/octet-stream';
}

// 절대 전송 상한 — serializer의 셀 출력 상한(5MB)과 동일 기준, WS 프레임 폭주 방지
const HARD_CAP_BYTES = 5 * 1024 * 1024;
const SVG_CAP_BYTES = 1 * 1024 * 1024;
// 애니메이션 GIF를 원본 그대로 보낼 수 있는 상한 (초과 시 첫 프레임 정적 변환)
const GIF_AS_IS_CAP_BYTES = 4 * 1024 * 1024;
// 단일 이미지 뷰 기본 최대폭 — 마크다운 임베드용 imageMaxWidth(기본 1280)보다 넓게,
// 화면 전체를 쓰는 뷰이므로 레티나 기준 1600px을 하한으로 보장한다
const SINGLE_IMAGE_MIN_MAXWIDTH = 1600;
const MIN_WIDTH = 480;

let sharpModule: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sharpModule = require('sharp');
} catch {
  Logger.warn('[imageShare] sharp not available — large images will not be optimized');
}

function toDataUri(mime: string, buf: Buffer): string {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export async function buildImagePayload(uri: vscode.Uri): Promise<ImageFullPayload> {
  const cfg = getConfig();
  const fsPath = uri.fsPath;
  const ext = path.extname(fsPath).toLowerCase();
  const base = {
    fileName: path.basename(fsPath),
    filePath: vscode.workspace.asRelativePath(uri, false),
  };

  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(fsPath);
  } catch (err) {
    return { ...base, error: `이미지 파일을 읽을 수 없습니다: ${String(err)}` };
  }

  const maxBytes = Math.min(Math.max(256, cfg.imageMaxSizeKB) * 1024, HARD_CAP_BYTES);

  // SVG: 텍스트 원본 그대로 (뷰어는 <img>로만 렌더 — 스크립트 실행 경로 없음)
  if (ext === '.svg') {
    if (buf.length > SVG_CAP_BYTES) {
      return { ...base, error: 'SVG 파일이 너무 큽니다 (1MB 제한)' };
    }
    return { ...base, mime: 'image/svg+xml', data: toDataUri('image/svg+xml', buf), originalBytes: buf.length };
  }

  // GIF: 애니메이션 보존 우선 — 상한 이하면 원본 그대로
  if (ext === '.gif' && buf.length <= Math.min(GIF_AS_IS_CAP_BYTES, maxBytes)) {
    return { ...base, mime: 'image/gif', data: toDataUri('image/gif', buf), originalBytes: buf.length };
  }

  // sharp 미가용 폴백: 상한 이하 원본 전송, 초과 시 에러
  if (!sharpModule) {
    if (buf.length <= maxBytes) {
      return { ...base, mime: getImageMime(ext), data: toDataUri(getImageMime(ext), buf), originalBytes: buf.length };
    }
    return { ...base, error: `이미지가 너무 큽니다 (${Math.round(buf.length / 1024)}KB) — 최적화 모듈(sharp)을 사용할 수 없어 공유할 수 없습니다` };
  }

  try {
    const meta = await sharpModule(buf).metadata();
    const maxWidth = Math.max(cfg.imageMaxWidth, SINGLE_IMAGE_MIN_MAXWIDTH);
    let width = Math.min(meta.width || maxWidth, maxWidth);
    let quality = 82;
    let out: Buffer | null = null;
    let mime = 'image/jpeg';

    // 품질/폭 단계 축소 루프 — imageMaxSizeKB 이하가 될 때까지 최대 4회
    for (let attempt = 0; attempt < 4; attempt++) {
      let p = sharpModule(buf).rotate(); // EXIF orientation 반영
      p = p.resize(width, null, { fit: 'inside', withoutEnlargement: true });
      let encoded: Buffer;
      if (meta.hasAlpha) {
        encoded = await p.webp({ quality: Math.max(quality, 60) }).toBuffer();
        mime = 'image/webp';
      } else {
        encoded = await p.jpeg({ quality, mozjpeg: true }).toBuffer();
        mime = 'image/jpeg';
      }
      out = encoded;
      if (encoded.length <= maxBytes) break;
      width = Math.max(MIN_WIDTH, Math.floor(width * 0.7));
      quality = Math.max(50, quality - 12);
    }

    if (!out || out.length > HARD_CAP_BYTES) {
      return { ...base, error: `이미지가 너무 커서 공유할 수 없습니다 (원본 ${Math.round(buf.length / 1024)}KB)` };
    }
    const outMeta = await sharpModule(out).metadata();
    return {
      ...base,
      mime,
      data: toDataUri(mime, out),
      width: outMeta.width,
      height: outMeta.height,
      originalBytes: buf.length,
    };
  } catch (err) {
    // 손상 파일 등 sharp 실패: 상한 이하면 원본 그대로, 아니면 에러
    Logger.warn(`[imageShare] sharp failed for ${fsPath}: ${String(err)}`);
    if (buf.length <= maxBytes) {
      return { ...base, mime: getImageMime(ext), data: toDataUri(getImageMime(ext), buf), originalBytes: buf.length };
    }
    return { ...base, error: '이미지 처리에 실패했습니다' };
  }
}
