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
import { image } from '@kit.ImageKit';
import { BusinessError } from '@kit.BasicServicesKit';
import LogUtil from '../utils/LogUtil';

const TAG: string = 'PdfInkWriter';
const MAX_PDF_BYTES: number = 300 * 1024 * 1024;
const MAX_STROKES: number = 1500;
const MAX_POINTS: number = 80000;
// Old annotations are found by this marker as well as by the uniqueId prefix.
// PDF Kit may rewrite/generate unique ids on save; relying on the id alone
// would leave the previous set in place and every auto-write would stack a
// second copy (dense "abstract art" instead of handwriting).
const INK_MARK: string = 'ohsidian-ink';

export interface PdfInkStroke {
  id?: string;
  pts: Array<Array<number>>;
  color: number;
  width: number;
  opacity: number;
  // "highlighter" becomes a /Highlight quad strip so its width is explicit;
  // everything else keeps the /PolyLine or /Ink vector path.
  tool?: string;
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
  // "ink" (standard /Ink) or "polyline" (/PolyLine). The latter is a
  // compatibility path for viewers/PDF Kit builds that fill /Ink paths.
  inkStyle?: string;
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

export interface PdfPreviewProbeResult {
  ok: boolean;
  ms: number;
  w: number;
  h: number;
  error: string;
}

export interface PdfPreviewResult {
  ok: boolean;
  ms: number;
  bytes: number;
  w: number;
  h: number;
  error: string;
}

export interface PdfPreviewPixelResult {
  ok: boolean;
  ms: number;
  w: number;
  h: number;
  error: string;
  bitmap: image.PixelMap | null;
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

  /**
   * Device-agent probe: how long does PDF Kit take to rasterize one page?
   * Used to decide whether a native first-paint preview is worth building.
   */
  static probePagePixelMap(src: string, page: number): PdfPreviewProbeResult {
    const result: PdfPreviewProbeResult = { ok: false, ms: 0, w: 0, h: 0, error: '' };
    const started: number = Date.now();
    if (!src || page < 0) {
      result.error = 'bad request';
      return result;
    }
    const doc = new pdfService.PdfDocument();
    try {
      const parse = doc.loadDocument(src);
      if (parse !== pdfService.ParseResult.PARSE_SUCCESS) {
        result.error = 'parse:' + parse;
        return result;
      }
      const pg = doc.getPage(page);
      const pm = pg.getPagePixelMap();
      result.ok = true;
      pm.release();
    } catch (e) {
      const err = e as BusinessError;
      result.error = 'exc:' + err.code + ' ' + err.message;
    } finally {
      try { doc.releaseDocument(); } catch (eR) {}
      result.ms = Date.now() - started;
    }
    return result;
  }

  /**
   * First-paint preview: rasterize one page with PDF Kit (native codecs) and
   * write a PNG. pdf.js needs ~10 s for this PDF's 5816x2044 JPEG + SMask on
   * the tablet; PDF Kit does the same page in ~300 ms. The renderer shows the
   * PNG until pdf.js' own canvas is ready.
   */
  static async renderPreview(src: string, page: number, width: number, height: number,
    out: string): Promise<PdfPreviewResult> {
    const result: PdfPreviewResult = { ok: false, ms: 0, bytes: 0, w: 0, h: 0, error: '' };
    const started: number = Date.now();
    if (!src || page < 0 || !out || width <= 0 || height <= 0) {
      result.error = 'bad request';
      return result;
    }
    const doc = new pdfService.PdfDocument();
    let pm: image.PixelMap | null = null;
    try {
      const parse = doc.loadDocument(src);
      if (parse !== pdfService.ParseResult.PARSE_SUCCESS) {
        result.error = 'parse:' + parse;
        return result;
      }
      const pg = doc.getPage(page);
      const pw: number = pg.getWidth();
      const ph: number = pg.getHeight();
      if (!(pw > 0) || !(ph > 0)) {
        result.error = 'page size';
        return result;
      }
      const m = new pdfService.PdfMatrix();
      m.x = 0;
      m.y = 0;
      m.width = pw;
      m.height = ph;
      m.rotate = 0;
      pm = pg.getAreaPixelMapWithOptions(m, width, height);
      if (pm === null) {
        result.error = 'no pixelmap';
        return result;
      }
      const packer: image.ImagePacker = image.createImagePacker();
      try {
        const opt: image.PackingOption = { format: 'image/png', quality: 100 };
        const buf: ArrayBuffer = await packer.packing(pm, opt);
        const slash: number = out.lastIndexOf('/');
        if (slash > 0) {
          try { fileIo.mkdirSync(out.substring(0, slash), true); } catch (eMk) {}
        }
        const f: fileIo.File = fileIo.openSync(out,
          fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
        try {
          fileIo.writeSync(f.fd, buf);
        } finally {
          fileIo.closeSync(f);
        }
        result.ok = true;
        result.bytes = buf.byteLength;
        result.w = width;
        result.h = height;
      } finally {
        try { packer.release(); } catch (ePr) {}
      }
    } catch (e) {
      const err = e as BusinessError;
      result.error = 'exc:' + err.code + ' ' + err.message;
    } finally {
      if (pm !== null) {
        try { pm.release(); } catch (ePm) {}
      }
      try { doc.releaseDocument(); } catch (eR) {}
      result.ms = Date.now() - started;
      LogUtil.info(TAG, 'preview page=' + page + ' ms=' + result.ms +
        ' bytes=' + result.bytes + ' ok=' + result.ok + (result.error ? ' err=' + result.error : ''));
    }
    return result;
  }

  /**
   * Rasterize one page directly to a PixelMap for the ArkUI first-paint
   * overlay. Synchronous; PDF Kit renders this PDF's cover in ~300 ms.
   */
  static renderPreviewPixelMap(src: string, page: number, width: number,
    height: number): PdfPreviewPixelResult {
    const result: PdfPreviewPixelResult = {
      ok: false, ms: 0, w: 0, h: 0, error: '', bitmap: null
    };
    const started: number = Date.now();
    if (!src || page < 0 || width <= 0 || height <= 0) {
      result.error = 'bad request';
      return result;
    }
    const doc = new pdfService.PdfDocument();
    try {
      const parse = doc.loadDocument(src);
      if (parse !== pdfService.ParseResult.PARSE_SUCCESS) {
        result.error = 'parse:' + parse;
        return result;
      }
      const pg = doc.getPage(page);
      const pw: number = pg.getWidth();
      const ph: number = pg.getHeight();
      if (!(pw > 0) || !(ph > 0)) {
        result.error = 'page size';
        return result;
      }
      const pm: image.PixelMap | null = pg.getPagePixelMap();
      if (pm === null) {
        result.error = 'no pixelmap';
        return result;
      }
      result.bitmap = pm;
      result.w = width;
      result.h = height;
      result.ok = true;
    } catch (e) {
      const err = e as BusinessError;
      result.error = 'exc:' + err.code + ' ' + err.message;
    } finally {
      try { doc.releaseDocument(); } catch (eR) {}
      result.ms = Date.now() - started;
    }
    return result;
  }

  static write(req: PdfInkRequest): PdfInkResult {
    const result: PdfInkResult = { ok: false, bytes: 0, error: '', backup: '' };
    const started: number = Date.now();
    const style: string = req.inkStyle === 'polyline' ? 'polyline' : 'ink';
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
      LogUtil.info(TAG, 'timing load page=' + req.page + ' ms=' + (Date.now() - started) +
        ' result=' + parse);
      if (parse !== pdfService.ParseResult.PARSE_SUCCESS) {
        result.error = '解析失败：' + parse + '（加密 PDF 需要密码，暂不支持）';
        PdfInkWriter.cleanup(cacheSrc, cacheOut);
        return result;
      }
      const page = doc.getPage(req.page);      // A timed-out request may still have been written by the system service.
      // Stroke ids are reused as annotation ids, so a retry skips what is
      // already in the PDF instead of stacking a second copy.
      const existingIds: Set<string> = new Set<string>();
      let removedCount: number = 0;
      if (req.replace) {
        // Remove only annotations this app created earlier. Other readers'
        // highlights/comments on the page are preserved. Match the marker as
        // well as the id: PDF Kit may rewrite unique ids when saving.
        try {
          const owned = page.getAnnotations();
          const removeSet: Set<string> = new Set<string>();
          if (req.removeIds) {
            for (let r = 0; r < req.removeIds.length; r++) {
              removeSet.add(req.removeIds[r]);
            }
          }
          for (let a = owned.length - 1; a >= 0; a--) {
            const uid = owned[a].uniqueId ? owned[a].uniqueId : '';
            let title: string = '';
            let content: string = '';
            let subject: string = '';
            // PdfAnnotation itself only exposes type/uniqueId; the marker is
            // on PdfAnnotationInfo. A failed info read must not abort the
            // whole write, so fall back to the id check.
            try {
              const ainfo = owned[a].getAnnotationInfo();
              title = ainfo && ainfo.title ? ainfo.title : '';
              content = ainfo && ainfo.content ? ainfo.content : '';
              subject = ainfo && ainfo.subject ? ainfo.subject : '';
            } catch (eInfo) {
              title = '';
              content = '';
              subject = '';
            }
            if ((uid && uid.indexOf('ohsidian-') === 0) || removeSet.has(uid) ||
              (title && title.indexOf(INK_MARK) === 0) ||
              (content && content.indexOf(INK_MARK) === 0) ||
              (subject && subject.indexOf(INK_MARK) === 0)) {
              page.removeAnnotation(owned[a]);
              removedCount++;
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
      let addedCount: number = 0;
      for (let s = 0; s < req.strokes.length; s++) {
        const stroke = req.strokes[s];
        const annId: string = 'ohsidian-' + (stroke.id ? stroke.id :
          (Date.now().toString(36) + '-' + s));
        if (existingIds.has(annId)) {
          continue;
        }
        const border = new pdfService.PdfBorder();
        border.borderStyle = pdfService.BorderStyle.SOLID;
        border.borderWidth = stroke.width;
        border.borderColor = stroke.color;
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
        if (stroke.tool === 'highlighter' && !normalized) {
          // A /Highlight stores the highlighted area as quads. Using the same
          // PDF-space width as the overlay makes screen and PDF agree exactly;
          // a /PolyLine's border width is not a reliable highlighter width in
          // every viewer and was the source of the visible size mismatch.
          const quads: Array<pdfService.PdfPoint> = PdfInkWriter.highlightQuads(pts, stroke.width);
          if (quads.length >= 4) {
            const hinfo = new pdfService.HighlightAnnotationInfo();
            hinfo.type = pdfService.AnnotationType.HIGHLIGHT;
            hinfo.uniqueId = annId;
            hinfo.color = stroke.color;
            hinfo.opacity = stroke.opacity;
            hinfo.quadPoints = quads;
            hinfo.title = INK_MARK;
            hinfo.content = INK_MARK + ' ' + annId;
            hinfo.subject = INK_MARK;
            page.addAnnotation(hinfo);
          } else {
            // Degenerate highlighter (single point): keep a vector dot.
            const pinfo = new pdfService.PolylineAnnotationInfo();
            pinfo.type = pdfService.AnnotationType.POLYLINE;
            pinfo.uniqueId = annId;
            pinfo.lineColor = stroke.color;
            pinfo.opacity = stroke.opacity;
            pinfo.border = border;
            pinfo.vertexes = pts;
            pinfo.title = INK_MARK;
            pinfo.content = INK_MARK + ' ' + annId;
            pinfo.subject = INK_MARK;
            page.addAnnotation(pinfo);
          }
        } else if (style === 'polyline') {
          const pinfo = new pdfService.PolylineAnnotationInfo();
          pinfo.type = pdfService.AnnotationType.POLYLINE;
          pinfo.uniqueId = annId;
          pinfo.lineColor = stroke.color;
          pinfo.opacity = stroke.opacity;
          pinfo.border = border;
          pinfo.vertexes = pts;
          pinfo.title = INK_MARK;
          pinfo.content = INK_MARK + ' ' + annId;
          pinfo.subject = INK_MARK;
          page.addAnnotation(pinfo);
        } else {
          const info = new pdfService.InkAnnotationInfo();
          info.type = pdfService.AnnotationType.INK;
          info.uniqueId = annId;
          info.lineColor = stroke.color;
          info.opacity = stroke.opacity;
          info.border = border;
          info.inkPoints = pts;
          info.title = INK_MARK;
          info.content = INK_MARK + ' ' + annId;
          info.subject = INK_MARK;
          page.addAnnotation(info);
        }
        addedCount++;
      }
      LogUtil.info(TAG, 'timing add style=' + style + ' removed=' + removedCount +
        ' added=' + addedCount + ' ms=' + (Date.now() - started));
      if (!doc.saveDocument(cacheOut)) {
        result.error = '保存 PDF 失败';
        PdfInkWriter.cleanup(cacheSrc, cacheOut);
        return result;
      }
      LogUtil.info(TAG, 'timing save ms=' + (Date.now() - started));
      // Re-open the saved file before it can replace the user's PDF. A header
      // check is not enough: a broken xref/annotation tree still starts with
      // "%PDF-" but makes pdf.js render white pages after the swap.
      const verifyDoc = new pdfService.PdfDocument();
      try {
        const vres = verifyDoc.loadDocument(cacheOut);
        const vpages = vres === pdfService.ParseResult.PARSE_SUCCESS ? verifyDoc.getPageCount() : 0;
        LogUtil.info(TAG, 'timing verify pages=' + vpages + ' ms=' + (Date.now() - started));
        if (vres !== pdfService.ParseResult.PARSE_SUCCESS || vpages < req.page + 1) {
          result.error = '写出的 PDF 校验失败（pages=' + vpages + '），已保留原文件';
          PdfInkWriter.cleanup(cacheSrc, cacheOut);
          return result;
        }
      } finally {
        try { verifyDoc.releaseDocument(); } catch (eVer) {}
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
    LogUtil.info(TAG, 'pdf ink written page=' + req.page + ' style=' + style +
      ' strokes=' + req.strokes.length + ' bytes=' + bytes +
      ' totalMs=' + (Date.now() - started));
    return result;
  }

  /**
   * Build PDF /Highlight quadPoints from a polyline: each segment becomes one
   * quad (UL, UR, LL, LR). The width is the same PDF-space width the renderer
   * uses for the overlay, so the annotation is not scaled or given a viewer's
   * default border width.
   */
  private static highlightQuads(points: Array<pdfService.PdfPoint>,
    width: number): Array<pdfService.PdfPoint> {
    const quads: Array<pdfService.PdfPoint> = [];
    const hw: number = Math.max(0.5, width) / 2;
    for (let i = 1; i < points.length; i++) {
      const x0: number = points[i - 1].x;
      const y0: number = points[i - 1].y;
      const x1: number = points[i].x;
      const y1: number = points[i].y;
      const dx: number = x1 - x0;
      const dy: number = y1 - y0;
      const len: number = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.01) {
        continue;
      }
      const nx: number = -dy / len * hw;
      const ny: number = dx / len * hw;
      const mk = (x: number, y: number): pdfService.PdfPoint => {
        const p = new pdfService.PdfPoint();
        p.x = x;
        p.y = y;
        return p;
      };
      quads.push(mk(x0 + nx, y0 + ny));
      quads.push(mk(x1 + nx, y1 + ny));
      quads.push(mk(x0 - nx, y0 - ny));
      quads.push(mk(x1 - nx, y1 - ny));
    }
    return quads;
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
