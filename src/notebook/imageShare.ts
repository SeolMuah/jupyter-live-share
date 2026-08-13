import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from '../utils/config';

/**
 * 단일 이미지 파일 공유 페이로드 빌더 (image:full 이벤트).
 * 처리 원칙:
 *  - 이미지는 원본 그대로 보낸다. 축소·재인코딩·EXIF 회전 보정은 하지 않는다.
 *    네이티브 이미지 처리 모듈(sharp)은 플랫폼별 바이너리라 배포본에 싣지 않는다.
 *    (예전에는 의존성에만 선언돼 있고 실제로는 배포되지 않아, 이 경로가 항상
 *     '모듈 없음' 폴백으로 돌고 있었다. 지금은 그 사실에 코드를 맞춘 것이다.)
 *  - imageMaxSizeKB(기본 2048KB) 또는 절대 상한(5MB)을 넘으면 전송하지 않고
 *    줄여 달라는 안내를 보낸다 (WS 폭주 방지)
 *  - GIF는 상한 이하면 원본 그대로 (애니메이션 보존)
 *  - SVG는 텍스트 그대로(1MB 제한). 뷰어가 <img>로만 렌더하므로 스크립트 실행 불가
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

  // GIF: 애니메이션 보존 우선. 상한 이하면 원본 그대로 (초과 시 아래 공통 안내)
  if (ext === '.gif' && buf.length <= Math.min(GIF_AS_IS_CAP_BYTES, maxBytes)) {
    return { ...base, mime: 'image/gif', data: toDataUri('image/gif', buf), originalBytes: buf.length };
  }

  // 이미지는 원본 그대로 전송한다. 축소·재인코딩은 하지 않는다.
  // (네이티브 이미지 처리 모듈을 배포본에 싣지 않기로 했다. 플랫폼별 바이너리 때문에
  //  패키지가 수십 MB로 커지고, 강사가 연 이미지가 네이티브 디코더를 통과하는
  //  공격면도 생긴다. 대신 상한을 넘으면 안내를 띄운다.)
  if (buf.length <= maxBytes) {
    return { ...base, mime: getImageMime(ext), data: toDataUri(getImageMime(ext), buf), originalBytes: buf.length };
  }
  return {
    ...base,
    error: `이미지가 너무 큽니다 (${Math.round(buf.length / 1024)}KB). `
      + `${Math.round(maxBytes / 1024)}KB 이하로 줄여서 다시 열어 주세요. `
      + `설정 codeClassLive.imageMaxSizeKB로 상한을 올릴 수 있습니다.`,
  };
}
