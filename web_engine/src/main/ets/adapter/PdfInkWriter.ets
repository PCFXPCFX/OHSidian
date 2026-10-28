/*
 * Copyright (c) 2023-2025 Haitai FangYuan Co., Ltd.
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this list of
 * conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list
 * of conditions and the following disclaimer in the documentation and/or other materials
 * provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used
 * to endorse or promote products derived from this software without specific prior written
 * permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS;
 * OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
 * OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
 * ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import { pdfService } from '@kit.PDFKit';
import { fileIo } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import LogUtil from '../utils/LogUtil';

const TAG: string = 'PdfInkWriter';
const MAX_PDF_BYTES: number = 300 * 1024 * 1024;
const MAX_STROKES: number = 1500;
const MAX_POINTS: number = 80000;

export interface PdfInkStroke {
  id?: string;
  pts: Array<Array<number>>;
  color: number;
  width: number;
  opacity: number;
}

export interface PdfInkRequest {
  src: string;
  page: number;
  strokes: Array<PdfInkStroke>;
  cacheDir: string;
  backupDir: string;
  // "vector": pts are PDF user-space points. "normalized": pts are 0..1 of
  // the rendered page, top-left origin (pdfdom fallback).
  mode?: string;
  // Remove our previous annotations on this page before adding the current
  // set. This is how erase/delete/modify stay in sync.
  replace?: boolean;
  // Annotation ids that belonged to this page's sidecar, including older
  // baked ones written before the ohsidian- prefix existed.
  removeIds?: Array<string>;
}

export interface PdfInkResult {
  ok: boolean;
  bytes: number;
  error: string;
  backup: string;
}

/**
 * Writes renderer-captured strokes into a PDF as real /Ink annotations.
 *
 * The document can never be read and written at the same time, so the flow is
 * always: copy to cache -> load -> add annotations -> save to a second cache
 * file -> validate -> back up the original -> atomically replace. Any failure
 * leaves the original byte-for-byte untouched.
 *
 * Coordinates and widths arrive in PDF user space points; the renderer derived
 * them from pdf.js' viewport, which already accounts for scale and rotation.
 */
export class PdfInkWriter {
  private static availableCache: number = -1;

  static available(): boolean {
    if (PdfInkWriter.availableCache >= 0) {
      return PdfInkWriter.availableCache === 1;
    }
    try {
      const ok: boolean = canIUse('SystemCapability.OfficeService.PDFService.Core');
      PdfInkWriter.availableCache = ok ? 1 : 0;
      return ok;
    } catch (e) {
      PdfInkWriter.availableCache = 0;
      return false;
    }
  }

  static write(req: PdfInkRequest): PdfInkResult {
    const result: PdfInkResult = { ok: false, bytes: 0, error: '', backup: '' };
    // Availability is checked by the UI-thread caller before dispatching the
    // task. Do not call canIUse again inside the taskpool worker: some ArkTS
    // builds do not expose capability queries on worker threads and that would
    // turn a valid write into a false "PDF Kit unavailable".
    if (!req || !req.src || !req.cacheDir || !req.backupDir) {
      result.error = '请求参数不完整';
      return result;
    }
    if (!req.strokes) {
      result.error = '笔画数组缺失';
      return result;
    }
    if (!req.replace && req.strokes.length === 0) {
      result.error = '没有待写入的笔画';
      return result;
    }
    if (req.strokes.length > MAX_STROKES) {
      result.error = '单次笔画过多（' + req.strokes.length + '）';
      return result;
    }
    let totalPoints: number = 0;
    for (let i = 0; i < req.strokes.length; i++) {
      totalPoints += req.strokes[i].pts.length;
    }
    if (totalPoints > MAX_POINTS) {
      result.error = '单次点数过多（' + totalPoints + '）';
      return result;
    }

    try {
      const st = fileIo.statSync(req.src);
      if (!st.isFile()) {
        result.error = '目标不是文件';
        return result;
      }
      if (st.size > MAX_PDF_BYTES) {
        result.error = 'PDF 过大（>' + Math.round(MAX_PDF_BYTES / 1048576) + 'MB），只保留叠加层';
        return result;
      }
    } catch (e) {
      const err = e as BusinessError;
      result.error = '读取 PDF 失败：' + err.code;
      return result;
    }

    let workDir: string = req.cacheDir + '/pdfink';
    try {
      fileIo.mkdirSync(workDir, true);
    } catch (e) {
      // Already exists is fine; a real failure surfaces on the copy below.
    }
    const token: string = Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000000).toString(36);
    const cacheSrc: string = workDir + '/src-' + token + '.pdf';
    const cacheOut: string = workDir + '/out-' + token + '.pdf';
    try {
      fileIo.copyFileSync(req.src, cacheSrc);
    } catch (e) {
      const err = e as BusinessError;
      result.error = '复制到缓存失败：' + err.code;
      return result;
    }

    const doc = new pdfService.PdfDocument();
    try {
      const parse = doc.loadDocument(cacheSrc);
      if (parse !== pdfService.ParseResult.PARSE_SUCCESS) {
        result.error = '解析失败：' + parse + '（加密 PDF 需要密码，暂不支持）';
        PdfInkWriter.cleanup(cacheSrc, cacheOut);
        return result;
      }
      const page = doc.getPage(req.page);      // A timed-out request may still have been written by the system service.
      // Stroke ids are reused as annotation ids, so a retry skips what is
      // already in the PDF instead of stacking a second copy.
      const existingIds: Set<string> = new Set<string>();
      if (req.replace) {
        // Remove only annotations this app created earlier. Other readers'
        // highlights/comments on the page are preserved.
        try {
          const owned = page.getAnnotations();
          const removeSet: Set<string> = new Set<string>();
          if (req.removeIds) {
            for (let r = 0; r < req.removeIds.length; r++) {
              removeSet.add(req.removeIds[r]);
            }
          }
          for (let a = owned.length - 1; a >= 0; a--) {
            const uid = owned[a].uniqueId;
            if (uid && (uid.indexOf('ohsidian-') === 0 || removeSet.has(uid))) {
              page.removeAnnotation(owned[a]);
            }
          }
        } catch (eRm) {
          const err = eRm as BusinessError;
          result.error = '清除旧注释失败，已取消写入：' + err.code;
          PdfInkWriter.cleanup(cacheSrc, cacheOut);
          return result;
        }
      }
      try {
        const existing = page.getAnnotations();
        for (let a = 0; a < existing.length; a++) {
          const eid = existing[a].uniqueId;
          if (eid) {
            existingIds.add(eid);
          }
        }
      } catch (eList) {
        // A page without a readable annotation list is written normally.
      }
      const normalized: boolean = req.mode === 'normalized';
      const pageW: number = normalized ? page.getWidth() : 0;
      const pageH: number = normalized ? page.getHeight() : 0;
      if (normalized && (!(pageW > 0) || !(pageH > 0))) {
        result.error = 'PDF 页面尺寸不可用，已保留叠加层';
        PdfInkWriter.cleanup(cacheSrc, cacheOut);
        return result;
      }
      for (let s = 0; s < req.strokes.length; s++) {
        const stroke = req.strokes[s];
        const annId: string = 'ohsidian-' + (stroke.id ? stroke.id :
          (Date.now().toString(36) + '-' + s));
        if (existingIds.has(annId)) {
          continue;
        }
        const info = new pdfService.InkAnnotationInfo();
        info.type = pdfService.AnnotationType.INK;
        info.uniqueId = annId;
        info.lineColor = stroke.color;
        info.opacity = stroke.opacity;
        const border = new pdfService.PdfBorder();
        border.borderStyle = pdfService.BorderStyle.SOLID;
        border.borderWidth = stroke.width;
        border.borderColor = stroke.color;
        info.border = border;
        const pts: Array<pdfService.PdfPoint> = [];
        for (let p = 0; p < stroke.pts.length; p++) {
          const pair = stroke.pts[p];
          const pt = new pdfService.PdfPoint();
          if (normalized) {
            pt.x = pair[0] * pageW;
            // Screen coordinates are top-left; PDF user space is bottom-left.
            pt.y = (1 - pair[1]) * pageH;
          } else {
            pt.x = pair[0];
            pt.y = pair[1];
          }
          pts.push(pt);
        }
        info.inkPoints = pts;
        page.addAnnotation(info);
      }
      if (!doc.saveDocument(cacheOut)) {
        result.error = '保存 PDF 失败';
        PdfInkWriter.cleanup(cacheSrc, cacheOut);
        return result;
      }
    } catch (e) {
      const err = e as BusinessError;
      result.error = '写入注释失败：' + err.code + ' ' + err.message;
      PdfInkWriter.cleanup(cacheSrc, cacheOut);
      return result;
    } finally {
      try {
        // Even a failed loadDocument may have allocated native handles.
        doc.releaseDocument();
      } catch (e) {
        // Nothing else to release.
      }
    }

    if (!PdfInkWriter.looksLikePdf(cacheOut)) {
      result.error = '写出的文件不是有效 PDF，已放弃替换';
      PdfInkWriter.cleanup(cacheSrc, cacheOut);
      return result;
    }

    // Backup before the destructive step. Prefer the vault-local backup dir;
    // if that is not writable (some sandboxed vaults deny .obsidian writes from
    // a taskpool worker), fall back to a sibling file next to the PDF.
    let backupPath: string = '';
    const siblingBackup: string = req.src + '.ohsidian-orig.pdf';
    try {
      fileIo.mkdirSync(req.backupDir, true);
      const base: string = PdfInkWriter.backupKey(req.src);
      const primary: string = req.backupDir + '/' + base + '.orig.pdf';
      let hasBackup: boolean = false;
      try {
        const bs = fileIo.statSync(primary);
        hasBackup = bs.isFile() && bs.size > 0;
      } catch (eB) {
        hasBackup = false;
      }
      if (!hasBackup) {
        fileIo.copyFileSync(req.src, primary);
      }
      backupPath = primary;
    } catch (ePrimary) {
      try {
        let hasSibling: boolean = false;
        try {
          const ss = fileIo.statSync(siblingBackup);
          hasSibling = ss.isFile() && ss.size > 0;
        } catch (eSib) {
          hasSibling = false;
        }
        if (!hasSibling) {
          fileIo.copyFileSync(req.src, siblingBackup);
        }
        backupPath = siblingBackup;
      } catch (eSibling) {
        const err = eSibling as BusinessError;
        result.error = '备份原文件失败（主备份与同目录备份均失败）：' + err.code;
        PdfInkWriter.cleanup(cacheSrc, cacheOut);
        return result;
      }
    }

    let bytes: number = 0;
    try {
      bytes = fileIo.statSync(cacheOut).size;
    } catch (e) {
      bytes = 0;
    }
    // cacheOut lives in the app cache, usually on another filesystem. Renaming
    // it directly over the PDF failed with cross-device/locked-file errors on
    // tablets, which surfaced as "替换原 PDF 失败". Copy into the PDF's own
    // directory first, then swap atomically; keep the old file until the new
    // one is in place.
    const localNew: string = req.src + '.hso-new-' + token + '.pdf';
    const localOld: string = req.src + '.hso-old-' + token + '.pdf';
    try {
      fileIo.copyFileSync(cacheOut, localNew);
      if (!PdfInkWriter.looksLikePdf(localNew)) {
        result.error = '写出的本地临时文件不是有效 PDF，已放弃替换';
        PdfInkWriter.cleanup(localNew, '');
        PdfInkWriter.cleanup(cacheSrc, cacheOut);
        return result;
      }
      try {
        fileIo.renameSync(localNew, req.src);
      } catch (eRename) {
        // Platform refuses rename-over-existing: move old aside, then swap.
        let movedOld: boolean = false;
        try {
          fileIo.renameSync(req.src, localOld);
          movedOld = true;
          fileIo.renameSync(localNew, req.src);
        } catch (eSwap) {
          if (movedOld) {
            try { fileIo.renameSync(localOld, req.src); } catch (eRestore) {}
          }
          throw eSwap as Error;
        }
        if (movedOld) {
          try { fileIo.unlinkSync(localOld); } catch (eOld) {}
        }
      }
      try { bytes = fileIo.statSync(req.src).size; } catch (eB2) {}
    } catch (e) {
      const err = e as BusinessError;
      result.error = '替换原 PDF 失败：' + err.code + '（备份在 ' + backupPath + '）';
      result.backup = backupPath;
      // Keep localOld if restoring it failed: it may be the only copy of the
      // original PDF. Only the new temp file is safe to delete here.
      PdfInkWriter.cleanup(localNew, '');
      PdfInkWriter.cleanup(cacheSrc, cacheOut);
      return result;
    }

    PdfInkWriter.cleanup(cacheSrc, cacheOut);
    result.ok = true;
    result.bytes = bytes;
    result.backup = backupPath;
    LogUtil.info(TAG, 'pdf ink written page=' + req.page + ' strokes=' + req.strokes.length + ' bytes=' + bytes);
    return result;
  }

  static backupPathFor(src: string, backupDir: string): string {
    return backupDir + '/' + PdfInkWriter.backupKey(src) + '.orig.pdf';
  }

  /** Primary vault backup, or the sibling fallback created when it failed. */
  static findBackup(src: string, backupDir: string): string {
    const primary: string = PdfInkWriter.backupPathFor(src, backupDir);
    try {
      const st = fileIo.statSync(primary);
      if (st.isFile() && st.size > 0) {
        return primary;
      }
    } catch (e) {
    }
    const sibling: string = src + '.ohsidian-orig.pdf';
    try {
      const st2 = fileIo.statSync(sibling);
      if (st2.isFile() && st2.size > 0) {
        return sibling;
      }
    } catch (e2) {
    }
    return primary;
  }

  /**
   * Restore the stable original backup. Uses a temporary copy + rename so a
   * failed restore cannot truncate the current PDF halfway through.
   */
  static restore(src: string, backup: string, cacheDir: string): PdfInkResult {
    const result: PdfInkResult = { ok: false, bytes: 0, error: '', backup: backup };
    let tmp: string = '';
    try {
      if (!backup || !PdfInkWriter.looksLikePdf(backup)) {
        result.error = '原始备份不存在或不是有效 PDF';
        return result;
      }
      tmp = cacheDir + '/pdfink/restore-' + Date.now().toString(36) + '.pdf';
      fileIo.mkdirSync(cacheDir + '/pdfink', true);
      fileIo.copyFileSync(backup, tmp);
      try {
        fileIo.renameSync(tmp, src);
      } catch (eR) {
        fileIo.copyFileSync(tmp, src);
        try { fileIo.unlinkSync(tmp); } catch (eU) {}
      }
      result.ok = true;
      try { result.bytes = fileIo.statSync(src).size; } catch (eS) { result.bytes = 0; }
      LogUtil.info(TAG, 'pdf ink restored from backup bytes=' + result.bytes);
      return result;
    } catch (e) {
      const err = e as BusinessError;
      result.error = '恢复失败：' + err.code;
      if (tmp) {
        try { fileIo.unlinkSync(tmp); } catch (eU) {}
      }
      return result;
    }
  }

  private static looksLikePdf(path: string): boolean {
    let f: fileIo.File | null = null;
    try {
      f = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
      const buf: ArrayBuffer = new ArrayBuffer(5);
      const n: number = fileIo.readSync(f.fd, buf);
      if (n < 5) {
        return false;
      }
      const bytes = new Uint8Array(buf);
      let sig: string = '';
      for (let i = 0; i < 5; i++) {
        sig += String.fromCharCode(bytes[i]);
      }
      return sig === '%PDF-';
    } catch (e) {
      return false;
    } finally {
      try {
        if (f !== null) {
          fileIo.closeSync(f);
        }
      } catch (e) {
      }
    }
  }

  private static backupKey(path: string): string {
    let h: number = 2166136261;
    for (let i = 0; i < path.length; i++) {
      h = (h ^ path.charCodeAt(i)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return PdfInkWriter.baseName(path) + '-' + h.toString(36);
  }

  private static baseName(path: string): string {
    const slash: number = path.lastIndexOf('/');
    const name: string = slash >= 0 ? path.substring(slash + 1) : path;
    const dot: number = name.lastIndexOf('.');
    return (dot > 0 ? name.substring(0, dot) : name).replace(/[\\/:*?"<>|]/g, '_');
  }

  private static cleanup(a: string, b: string): void {
    try {
      if (a) {
        fileIo.unlinkSync(a);
      }
    } catch (e) {
    }
    try {
      if (b) {
        fileIo.unlinkSync(b);
      }
    } catch (e) {
    }
  }
}
