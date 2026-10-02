/*
 * Copyright (c) 2023-2025 Haitai FangYuan Co., Ltd.
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this list of
 *    conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list
 *    of conditions and the following disclaimer in the documentation and/or other materials
 *    provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used
 *    to endorse or promote products derived from this software without specific prior written
 *    permission.
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

import { injectable } from 'inversify';
import { OhosDragParamToJs, OhosDropData } from '../interface/CommonInterface';
import UDC from '@ohos.data.unifiedDataChannel';
import UTD from '@ohos.data.uniformTypeDescriptor';
import LogUtil from '../utils/LogUtil';
import unifiedDataChannel from '@ohos.data.unifiedDataChannel';
import { fileUri } from '@kit.CoreFileKit';
import fs from '@ohos.file.fs';
import { ConfigData } from './Constants';
import uniformTypeDescriptor from '@ohos.data.uniformTypeDescriptor';
import { deviceInfo } from '@kit.BasicServicesKit';
import { uniformDataStruct } from '@kit.ArkData';

interface IDragParams {
  id: string,
  uiContext: UIContext | undefined
};

interface CustomDragData {
  uniformDataType: string,
  bufferData: ArrayBuffer
}

AppStorage.setOrCreate('dragParamList', new Map<string,IDragParams>());

const BOOKMARK_DEFINED_TYPE: string = "ApplicationDefinedType-bookmark";
const WEB_CUSTOM_DEFINED_TYPE: string = "ApplicationDefinedType-webCustom";
const APPLICATION_DEFINE_TYPE: string = "ApplicationDefinedType";
// System external-storage root is /storage/Users (plural); the trailing drag
// fallback paths must match, or downstream IO on them fails.
const FILE_DRAG_DEFAULT_NAME = "/storage/Users/currentUser/file.txt";
const IMAGE_DRAG_DEFAULT_NAME = "/storage/Users/currentUser/file.png";
const VIDEO_DRAG_DEFAULT_NAME = "/storage/Users/currentUser/file.mp4";
const AUDIO_DRAG_DEFAULT_NAME = "/storage/Users/currentUser/file.mp3";
const FOLDER_DRAG_DEFAULT_NAME = "/storage/Users/currentUser";
const HYPERLINK_DRAG_DEFAULT_URL = "https://www.exampleholder.com";
const HYPERLINK_DRAG_DEFAULT_TITLE = "ExampleHolder";
const PLAINTEXT_DRAG_DEFAULT_VALUE = "ExamplePlainText";
const UTD_FILE_URI = "general.file-uri";
const TAG: string = 'OhosDrag';
// Cache subdirectory where files dragged in from OTHER apps (中转站, 碰一碰,
// share targets) are copied before being handed to the engine: cross-app
// sandbox paths are not mounted in our namespace, so the engine can only
// read a copy that lives inside our own sandbox.
const DRAG_IN_DIRNAME: string = "drag-in";
const DRAG_IN_STALE_MS: number = 24 * 60 * 60 * 1000;
// Path segment mapping /storage/Users/currentUser/appdata/<elN>/base/<bundle>/...
// to the bundle-scoped file URI (file://<bundle>/data/storage/...) that
// URI-permission grants attach to.
const APPDATA_PATH_PREFIX: string = "/storage/Users/currentUser/appdata/";

@injectable()
export class DragParamManager {
  constructor() {
    let appStorageLink: SubscribedAbstractProperty<Map<string,IDragParams>> = AppStorage.link('dragParamList');
    this.appStorage = appStorageLink.get();
  }
  private appStorage: Map<string,IDragParams>;
  private dragData: UDC.UnifiedData | undefined = undefined

  private paramNormalization(windowId: string | number): string {
    if (typeof windowId === 'number') {
      return ConfigData.WINDOW_PREFIX + windowId;
    }
    return windowId;
  }

  public addDragContextData(data: IDragParams) {
    if (data && data.id) {
      this.appStorage.set(data.id, data);
    }
  }

  public removeDragContextData(windowId: string | number) {
    let id = this.paramNormalization(windowId);
    this.appStorage.delete(id);
  }

  public setUiContext(windowId: string | number, uiContext: UIContext): void {
    let id = this.paramNormalization(windowId);
    let current = this.appStorage.get(id);
    if (current) {
      current.uiContext = uiContext;
      this.appStorage.set(id, current);
    }
  }

  public getUiContext(windowId: string | number): UIContext | undefined {
    let id = this.paramNormalization(windowId);
    let current = this.appStorage.get(id);
    if (current) {
      return current.uiContext;
    }
    return undefined;
  }

  /**
   * For the single-entry when data dragging
   * @param dragParams Initial drag-and-drop data
   * @returns Drag data required by the drag framework.
   */
  public handleDragRecords(dragParams: OhosDragParamToJs): UDC.UnifiedData | undefined {
    this.dragData = undefined;
    let dragContents: Array<UDC.UnifiedRecord> = [];
    let dragDataHtml: UDC.HTML|undefined = undefined;
    let dragDataText: UDC.PlainText|undefined = undefined;
    let dragDataHyperlink: UDC.Hyperlink|undefined = undefined;
    if (dragParams.text) {
      LogUtil.info(TAG, `handleDragRecords text-length:${dragParams.text.length}`);
      dragDataText = new UDC.PlainText();
      dragDataText.textContent = dragParams.text;
      dragContents.push(dragDataText);
      dragDataHtml = new UDC.HTML();
      dragDataHtml.plainContent = dragParams.text;
      dragContents.push(dragDataHtml);
    }
    if (dragParams.html) {
      LogUtil.info(TAG, `handleDragRecords html-length:${dragParams.html.length}`);
      if (!dragDataHtml) {
        dragDataHtml = new UDC.HTML();
        dragContents.push(dragDataHtml);
      }
      dragDataHtml.htmlContent = dragParams.html;
      if (dragParams.text) {
        dragDataHtml.plainContent = dragParams.text;
      }
    }
    if (dragParams.urlTitle) {
      LogUtil.info(TAG, `handleDragRecords urlTitle-length:${dragParams.urlTitle.length}`);
      dragDataHyperlink = new UDC.Hyperlink();
      dragDataHyperlink.description = dragParams.urlTitle;
      dragContents.push(dragDataHyperlink);
    }
    if (dragParams.url) {
      LogUtil.info(TAG, `handleDragRecords url-length:${dragParams.url.length}`);
      if (dragDataHyperlink !== undefined) {
        dragDataHyperlink.url = dragParams.url;
      } else {
        dragDataHyperlink = new UDC.Hyperlink();
        dragDataHyperlink.url = dragParams.url;
        dragContents.push(dragDataHyperlink);
      }
    }
    if (dragParams.webImageFilePath) {
      LogUtil.info(TAG, `handleDragRecords webImageFilePath-length:${dragParams.webImageFilePath.length}`);
      let image: UDC.Image | undefined = this.handleImageDragUri(dragParams.webImageFilePath);
      if (image) {
        dragContents.push(image);
      }
    }
    if (dragParams.electronFilePath) {
      LogUtil.info(TAG, `handleDragRecords electronFilePath-length:${dragParams.electronFilePath.length}`);
      let file: UDC.File | undefined = this.handleFileDragUri(dragParams.electronFilePath);
      if (file) {
        dragContents.push(file);
      }
    }
    if (dragParams.bookmarkBuffer?.byteLength > 0) {
      LogUtil.info(TAG, `handleDragRecords bookmarkBuffer-length:${dragParams.bookmarkBuffer?.byteLength}`);
      let record = new unifiedDataChannel.ApplicationDefinedRecord();
      record.applicationDefinedType = BOOKMARK_DEFINED_TYPE;
      record.rawData = new Uint8Array(dragParams.bookmarkBuffer);
      dragContents.push(record);
    }
    if (dragParams.webCustomBuffer?.byteLength > 0) {
      LogUtil.info(TAG, `handleDragRecords webCustomBuffer-length:${dragParams.webCustomBuffer?.byteLength}`);
      let record = new unifiedDataChannel.ApplicationDefinedRecord();
      record.applicationDefinedType = WEB_CUSTOM_DEFINED_TYPE;
      record.rawData = new Uint8Array(dragParams.webCustomBuffer);
      dragContents.push(record);
    }
    if (dragContents.length === 0) {
      LogUtil.error(TAG, `handleDragRecords fail, dragContents is empty`);
      return this.dragData;
    }
    this.dragData = new UDC.UnifiedData(dragContents[0]);
    for (let i = 1; i < dragContents.length; i++) {
      this.dragData.addRecord(dragContents[i]);
    }
    return this.dragData;
  }

  /**
   * For the multi-entry when data dragging
   * @param dragParams Initial drag-and-drop data
   * @returns Drag data required by the drag framework.
   */
  public handleDragDataForEntries(dragParams: OhosDragParamToJs): UDC.UnifiedData | undefined {
    this.dragData = undefined;
    let dragContents:(uniformDataStruct.PlainText |uniformDataStruct.HTML |uniformDataStruct.Hyperlink
                    |uniformDataStruct.FileUri |CustomDragData)[] = [];

    let plainText = this.handleTextDragDataForEntries(dragParams);
    if (plainText) {
      dragContents.push(plainText);
    }
    let htmlUds = this.handleHtmlDragDataForEntries(dragParams);
    if (htmlUds) {
      dragContents.push(htmlUds);
    }
    let hyperlinkUds = this.handleHyperlinkDragDataForEntries(dragParams);
    if (hyperlinkUds) {
      dragContents.push(hyperlinkUds);
    }
    let imageUds = this.handleWebImageForEntries(dragParams);
    if (imageUds) {
      LogUtil.info(TAG, `handleDragDataForEntries webImageFilePath-length:${dragParams.webImageFilePath.length}`);
      dragContents.push(imageUds);
    }
    let bookmarkStruct = this.handleBookmarkDragDataForEntries(dragParams);
    if (bookmarkStruct) {
      dragContents.push(bookmarkStruct);
    }
    let webCustomDataStruct = this.handleWebCustomDataForEntries(dragParams);
    if (webCustomDataStruct) {
      dragContents.push(webCustomDataStruct);
    }
    if (dragContents.length == 0) {
      LogUtil.error(TAG, `handleDragDataForEntries fail, dragContents is empty`);
      return;
    }
    let record = new unifiedDataChannel.UnifiedRecord(dragContents[0].uniformDataType, dragContents[0]);
    for (let i = 1; i < dragContents.length; i++) {
      record.addEntry(dragContents[i].uniformDataType, dragContents[i]);
    }
    this.dragData = new UDC.UnifiedData(record);
    return this.dragData;
  }

  public handleDropDataForEnter(summary: Summary) : OhosDropData {
    let dropData: OhosDropData = {
      text: "",
      url: "",
      urlTitle: "",
      html: "",
      fileUris: new Array,
      bookmarkBuffer: new ArrayBuffer(0),
      webCustomBuffer: new ArrayBuffer(0)
    };
    if (this.dragData && this.dragData.getRecords() && this.dragData.getRecords().length > 0) {
      // this.dragData is only populated while THIS app drives the drag, so
      // this branch is by definition a local (self-initiated) drag.
      if (deviceInfo.sdkApiVersion >= 15) {
        this.handleDropDataFromRecordsForEntries(this.dragData.getRecords(), dropData, true);
      } else {
        this.handleDropDataFromRecords(this.dragData.getRecords(), dropData, true);
      }
      return dropData;
    }
    // summary.summary maps UTD type -> data size (Record<string, number>).
    // The old code parsed it as Array<string> and indexed records[i][0], so
    // the switch below never matched and external drags got no placeholder
    // data on dragEnter. Iterate the keys (the types) instead.
    let summaryTypes: Array<string>;
    try {
      summaryTypes = Object.keys(summary.summary);
    } catch (err) {
      LogUtil.warn(TAG, `On handleDropDataForEnter summary parse failed: ${JSON.stringify(err)}`);
      return dropData;
    }
    if (!summaryTypes || summaryTypes.length === 0) {
      LogUtil.warn(TAG, `On handleDropDataForEnter summary records is null`);
      return dropData;
    }
    for(let i = 0; i < summaryTypes.length; i++) {
      let summaryType = summaryTypes[i];
      LogUtil.info(TAG, `On handleDropDataForEnter dragData summary type:${summaryType}`);
      switch (summaryType) {
        case UTD.UniformDataType.PLAIN_TEXT:
          dropData.text = PLAINTEXT_DRAG_DEFAULT_VALUE;
          break;
        case UTD.UniformDataType.HYPERLINK:
          dropData.url = HYPERLINK_DRAG_DEFAULT_URL;
          dropData.urlTitle = HYPERLINK_DRAG_DEFAULT_TITLE;
          break;
        case UTD.UniformDataType.FILE:
          dropData.fileUris.push(FILE_DRAG_DEFAULT_NAME);
          break;
        case UTD.UniformDataType.IMAGE:
          dropData.fileUris.push(IMAGE_DRAG_DEFAULT_NAME);
          break;
        case UTD.UniformDataType.VIDEO:
          dropData.fileUris.push(VIDEO_DRAG_DEFAULT_NAME);
          break;
        case UTD.UniformDataType.AUDIO:
          dropData.fileUris.push(AUDIO_DRAG_DEFAULT_NAME);
          break;
        case UTD.UniformDataType.FOLDER:
        case UTD_FILE_URI:
          // on drag enter event,there is no actual data. use temporary data
          dropData.fileUris.push(FILE_DRAG_DEFAULT_NAME);
          break;
        default:
          LogUtil.info(TAG, `On handleDropDataForEnter dragData,
                       type: ${summaryType} do not need default data`);
          break;
      }
    }
    return dropData;
  }

  public handleDropDataForDrop(dragData: UnifiedData, isLocalDrag: boolean = false) : OhosDropData {
    let dropData: OhosDropData = {
      text: "",
      url: "",
      urlTitle: "",
      html: "",
      fileUris: new Array,
      bookmarkBuffer: new ArrayBuffer(0),
      webCustomBuffer: new ArrayBuffer(0)
    };
    if (!dragData) {
      LogUtil.warn(TAG, `On handleDropDataForDrop dragData is undefined`);
      return dropData;
    }
    let records: Array<UDC.UnifiedRecord> = dragData.getRecords();
    if (!records) {
      LogUtil.warn(TAG, `On handleDropDataForDrop dragData records is undefined`);
      return dropData;
    }
    if (deviceInfo.sdkApiVersion >= 15) {
      this.handleDropDataFromRecordsForEntries(records, dropData, isLocalDrag);
    } else {
      this.handleDropDataFromRecords(records, dropData, isLocalDrag);
    }
    this.dedupFileUris(dropData);
    return dropData;
  }

  private dedupFileUris(dropData: OhosDropData) {
    let seen = new Set<string>();
    let unique: Array<string> = [];
    for (let i = 0; i < dropData.fileUris.length; i++) {
      let uri = dropData.fileUris[i];
      if (!uri || seen.has(uri)) {
        continue;
      }
      seen.add(uri);
      unique.push(uri);
    }
    dropData.fileUris = unique;
  }

  /**
   * External drops (中转站, 文件管理器, 碰一碰/分享) must reach the engine as
   * files it can actually read - never as a bare file:// link pointing into
   * another app's sandbox. The engine builds DataTransfer.files from
   * `fileUris`; when a uri is unreadable, or fileUris is empty and only the
   * file location leaked through as plain text, the renderer instead sees a
   * link, which Obsidian turns into the "Open external link?" prompt and
   * never inserts anything.
   */
  public async sanitizeExternalDropData(dropData: OhosDropData, cacheDir: string): Promise<OhosDropData> {
    try {
      let textIsPath = DragParamManager.isPathLikeText(dropData.text);
      let urlIsPath = DragParamManager.isPathLikeText(dropData.url);
      if (dropData.fileUris.length === 0 && (textIsPath || urlIsPath)) {
        // Source apps like hiwrite (single-image drag) often send the file
        // location as a PlainText record instead of a file record. Promote
        // it to a real file uri so the engine can build a File from it.
        dropData.fileUris.push((textIsPath ? dropData.text : dropData.url).trim());
        LogUtil.info(TAG, `sanitizeExternalDropData, promoted path-like text to fileUris`);
      }
      if (textIsPath) {
        // Otherwise the engine puts the file:// uri into the uri-list and
        // Obsidian treats the drop as an external link.
        dropData.text = "";
      }
      if (urlIsPath) {
        dropData.url = "";
        dropData.urlTitle = "";
      }
      if (dropData.fileUris.length === 0) {
        return dropData;
      }
      if (!cacheDir) {
        LogUtil.warn(TAG, `sanitizeExternalDropData, no cacheDir, skip readability fixups`);
        this.dedupFileUris(dropData);
        return dropData;
      }
      this.purgeStaleDragInCopies(cacheDir);
      this.ensureDragInDir(cacheDir);
      let resolved: Array<string> = [];
      for (let i = 0; i < dropData.fileUris.length; i++) {
        let rawUri = dropData.fileUris[i];
        if (!rawUri) {
          continue;
        }
        let uri = rawUri.trim();
        try {
          resolved.push(await this.resolveReadableFileUri(uri, cacheDir, i));
        } catch (err) {
          LogUtil.error(TAG, `sanitizeExternalDropData, resolve failed for ${uri}: ${JSON.stringify(err)}`);
          resolved.push(uri);
        }
      }
      dropData.fileUris = resolved;
      this.dedupFileUris(dropData);
    } catch (err) {
      LogUtil.error(TAG, `sanitizeExternalDropData failed, keep raw drop data: ${JSON.stringify(err)}`);
    }
    return dropData;
  }

  private static isPathLikeText(value: string): boolean {
    if (!value) {
      return false;
    }
    let trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 2048) {
      return false;
    }
    return trimmed.startsWith("file://") || trimmed.startsWith("/storage/") || trimmed.startsWith("/data/");
  }

  private async resolveReadableFileUri(uri: string, cacheDir: string, index: number): Promise<string> {
    let filePath = uri.startsWith("file://") ? uri.substring("file://".length) : uri;
    // Readable by path inside our own process (shared storage, our sandbox,
    // engine-owned temp files): pass through untouched - file-manager drags
    // already arrive in this shape and the engine reads them fine.
    let accessible = false;
    try {
      accessible = fs.accessSync(filePath);
    } catch (err) {
      accessible = false;
    }
    if (accessible) {
      return uri;
    }
    // Cross-app sources (e.g. 中转站 appdata) are not mounted in our
    // namespace. The drop grants temporary URI permission, so open the file
    // through its URI and copy the bytes into our cache; the engine then
    // reads the copy like any local file. The index keeps same-millisecond
    // copies of identically named files from clobbering each other.
    let destPath = `${cacheDir}/${DRAG_IN_DIRNAME}/${Date.now()}-${index}-${DragParamManager.baseName(filePath)}`;
    let source = DragParamManager.openTargetForUri(uri, filePath);
    try {
      await this.copyViaOpen(source, destPath);
    } catch (firstErr) {
      let bundleUri = DragParamManager.bundleScopedUri(filePath);
      if (!bundleUri || bundleUri === source) {
        throw firstErr as Error;
      }
      LogUtil.info(TAG, `sanitizeExternalDropData, open failed (${JSON.stringify(firstErr)}), retry as ${bundleUri}`);
      await this.copyViaOpen(bundleUri, destPath);
    }
    LogUtil.info(TAG, `sanitizeExternalDropData, copied external file into cache: ${destPath}`);
    return "file://" + destPath;
  }

  private async copyViaOpen(source: string, destPath: string): Promise<void> {
    let srcFile = fs.openSync(source, fs.OpenMode.READ_ONLY);
    try {
      // Round 96: the Promise copyFile runs on an internal thread - the
      // sync copyFileSync version blocked the ArkTS UI thread for the
      // whole transfer (hundreds of MB from 中转站/分享 = seconds of
      // frozen rendering and input; the "video drag wedges the app"
      // report). The fd is closed only after the await settles.
      await fs.copyFile(srcFile.fd, destPath);
    } finally {
      fs.closeSync(srcFile);
    }
  }

  private static openTargetForUri(uri: string, filePath: string): string {
    if (!uri.startsWith("file://")) {
      return uri;
    }
    // "file://<bundle>/data/storage/..." must stay a URI (URI permission is
    // granted per-uri); "file:///abs/path" (empty authority) is just an
    // absolute path spelled with a scheme.
    return uri.startsWith("file:///") ? filePath : uri;
  }

  private static bundleScopedUri(filePath: string): string {
    let index = filePath.indexOf(APPDATA_PATH_PREFIX);
    if (index < 0) {
      return "";
    }
    let relative = filePath.substring(index + APPDATA_PATH_PREFIX.length);
    // <el1|el2>/base/<bundleName>/<rest> -> file://<bundleName>/data/storage/<elN>/base/<rest>
    let match = /^(el[12])\/base\/([^/]+)\/(.*)$/.exec(relative);
    if (!match) {
      return "";
    }
    return `file://${match[2]}/data/storage/${match[1]}/base/${match[3]}`;
  }

  private static baseName(filePath: string): string {
    if (!filePath) {
      return "";
    }
    let name = filePath.substring(filePath.lastIndexOf("/") + 1);
    return name ? name : "file";
  }

  private ensureDragInDir(cacheDir: string): void {
    let dir = `${cacheDir}/${DRAG_IN_DIRNAME}`;
    try {
      if (!fs.accessSync(dir)) {
        fs.mkdirSync(dir, true);
      }
    } catch (err) {
      // Already exists or mkdir raced - copyFileSync below surfaces real errors.
    }
  }

  private purgeStaleDragInCopies(cacheDir: string): void {
    let dir = `${cacheDir}/${DRAG_IN_DIRNAME}`;
    try {
      if (!fs.accessSync(dir)) {
        return;
      }
      let cutoff = Date.now() - DRAG_IN_STALE_MS;
      let names = fs.listFileSync(dir);
      for (let i = 0; i < names.length; i++) {
        let path = `${dir}/${names[i]}`;
        try {
          let stat = fs.statSync(path);
          // Stat.mtime is seconds on some API levels and ms on others.
          let mtimeMs = stat.mtime < 100000000000 ? stat.mtime * 1000 : stat.mtime;
          if (mtimeMs < cutoff) {
            fs.unlinkSync(path);
          }
        } catch (err) {
          // best effort: unreadable entries are left alone
        }
      }
    } catch (err) {
      LogUtil.warn(TAG, `purgeStaleDragInCopies failed: ${JSON.stringify(err)}`);
    }
  }

  /**
   * For the single-entry when data dragging
   * @param dragParams Initial drag-and-drop data
   * @returns Drag data required by the drag framework.
   */
  private handleDropDataFromRecords(records: Array<UDC.UnifiedRecord>, dropData: OhosDropData, isLocalDrag: boolean = false) {
    records.forEach((record) => {
      let recordType = record.getType();
      LogUtil.info(TAG, `handleDropDataFromRecords, recordType: ${recordType}`);
      switch (recordType) {
        case UTD.UniformDataType.PLAIN_TEXT:
          let plainText = record as unifiedDataChannel.PlainText;
          dropData.text = plainText.textContent;
          LogUtil.info(TAG, `handleDropDataFromRecords, text data length: ${dropData.text.length}`);
          break;
        case UTD.UniformDataType.HYPERLINK:
          let hyperlink = record as unifiedDataChannel.Hyperlink;
          dropData.url = hyperlink.url;
          dropData.urlTitle = hyperlink.description ? hyperlink.description : "";
          LogUtil.info(TAG, `handleDropDataFromRecords, url data length: ${dropData.url.length}`);
          LogUtil.info(TAG, `handleDropDataFromRecords, url title data length: ${dropData.urlTitle.length}`);
          break;
        case UTD.UniformDataType.HTML:
          let html = record as unifiedDataChannel.HTML;
          dropData.html = html.htmlContent;
          LogUtil.info(TAG, `handleDropDataFromRecords, html data length: ${dropData.html.length}`);
          break;
        case APPLICATION_DEFINE_TYPE:
          this.loadApplicationDefineData(dropData);
          break;
        case UTD.UniformDataType.FILE:
        case UTD.UniformDataType.IMAGE:
        case UTD.UniformDataType.VIDEO:
        case UTD.UniformDataType.AUDIO:
        case UTD.UniformDataType.FOLDER:
          if (isLocalDrag) {
            // web page images do not require push filePath
            let webImage = this.getRecord(UTD.UniformDataType.IMAGE) as UDC.Image;
            if (webImage) {
              break;
            }
          }
          if (recordType === UTD.UniformDataType.IMAGE) {
            // UDC.Image carries imageUri, not uri; casting to File yields
            // undefined for image records.
            let imageRecord = record as unifiedDataChannel.Image;
            if (imageRecord.imageUri) {
              dropData.fileUris.push(imageRecord.imageUri);
              break;
            }
          }
          let file = record as unifiedDataChannel.File;
          dropData.fileUris.push(file.uri);
          LogUtil.info(TAG, `handleDropDataFromRecords, fileUris data length: ${dropData.fileUris.length}`);
          break;
        default:
          LogUtil.warn(TAG, `On handleDropDataFromRecords dragData, type: ${recordType} not support`);
          break;
      }
    })
    LogUtil.info(TAG, `handleDropDataFromRecords, fileUris size: ${dropData.fileUris.length}`);
  }

  /**
   * For the multi-entry when data drop
   * @param dragParams Initial drag-and-drop data
   * @returns Drag data required by the drag framework.
   */
  private handleDropDataFromRecordsForEntries(records: Array<UDC.UnifiedRecord>, dropData: OhosDropData, isLocalDrag: boolean = false) {
    records.forEach((record) => {
      let entryMap = record.getEntries();
      record.getTypes().forEach((recordType) => {
        LogUtil.info(TAG, `handleDropDataFromRecordsForEntries, recordType: ${recordType}`);
        switch (recordType) {
          case UTD.UniformDataType.PLAIN_TEXT:
            let plainText: uniformDataStruct.PlainText = entryMap[uniformTypeDescriptor.UniformDataType.PLAIN_TEXT] as uniformDataStruct.PlainText
            if (plainText) {
              dropData.text = plainText.textContent;
            }
            LogUtil.info(TAG, `handleDropDataFromRecordsForEntries, text data length: ${dropData.text.length}`);
            break;
          case UTD.UniformDataType.HYPERLINK:
            let hyperlink: uniformDataStruct.Hyperlink =
              entryMap[uniformTypeDescriptor.UniformDataType.HYPERLINK] as uniformDataStruct.Hyperlink;
            if (hyperlink) {
              dropData.url = hyperlink.url;
              dropData.urlTitle = hyperlink.description ? hyperlink.description : "";
            }
            LogUtil.info(TAG, `handleDropDataFromRecordsForEntries, url data length: ${dropData.url.length}`);
            LogUtil.info(TAG, `handleDropDataFromRecordsForEntries, url title data length: ${dropData.urlTitle.length}`);
            break;
          case UTD.UniformDataType.HTML:
            let html: uniformDataStruct.HTML =
              entryMap[uniformTypeDescriptor.UniformDataType.HTML] as uniformDataStruct.HTML;
            if (html) {
              dropData.html = html.htmlContent;
            }
            LogUtil.info(TAG, `handleDropDataFromRecordsForEntries, html data length: ${dropData.html.length}`);
            break;
          case BOOKMARK_DEFINED_TYPE:
            let bookmarkData: ArrayBuffer|undefined = this.loadApplicationDefineDataForEntries(BOOKMARK_DEFINED_TYPE);
            if (bookmarkData) {
              dropData.bookmarkBuffer = bookmarkData;
            }
            break;
          case WEB_CUSTOM_DEFINED_TYPE:
            let webCustomData = this.loadApplicationDefineDataForEntries(WEB_CUSTOM_DEFINED_TYPE);
            dropData.webCustomBuffer = webCustomData;
            break;
          case UTD_FILE_URI:
            // Local drags keep the legacy web-image short-circuit: for a web
            // image dragged out of Obsidian the engine already owns the temp
            // file and rebuilds the drop from html/text, so the uri must NOT
            // be pushed. For EXTERNAL sources (中转站, 文件管理器, 碰一碰)
            // this short-circuit silently ate the uri: a lone general.file-uri
            // record matches getRecordForEntries() against records[0] (itself),
            // so the guard was always truthy and the file never reached the
            // engine - only the path leaked as text, which Obsidian then
            // offered to "open" instead of inserting.
            if (isLocalDrag) {
              let webImage = this.getRecordForEntries(UTD_FILE_URI) as uniformDataStruct.FileUri;
              if (webImage) {
                LogUtil.info(TAG, `handleDropDataFromRecordsForEntries, local web image, skip file uri push`);
                break;
              }
            }
            let extFileUri = entryMap[UTD_FILE_URI] as uniformDataStruct.FileUri;
            if (extFileUri && extFileUri.oriUri) {
              LogUtil.info(TAG, `handleDropDataFromRecordsForEntries, FILE_URI data length: ${extFileUri.oriUri.length}`);
              dropData.fileUris.push(extFileUri.oriUri);
            } else {
              let recUri = this.readUriFromRecord(record);
              if (recUri) {
                LogUtil.info(TAG, `handleDropDataFromRecordsForEntries, FILE_URI fallback from record, length: ${recUri.length}`);
                dropData.fileUris.push(recUri);
              } else {
                LogUtil.warn(TAG, `handleDropDataFromRecordsForEntries, FILE_URI entry has no oriUri`);
              }
            }
            break;
          case UTD.UniformDataType.FILE:
          case UTD.UniformDataType.IMAGE:
          case UTD.UniformDataType.VIDEO:
          case UTD.UniformDataType.AUDIO:
          case UTD.UniformDataType.FOLDER:
            // Multi-entry records carry payloads in the entry map, not on
            // the record itself: `record as unifiedDataChannel.File` has no
            // uri on SDK >= 15 and pushed undefined. File-shaped payloads
            // are FileUri structs (oriUri), keyed by the record's own type.
            let fileEntry = entryMap[recordType] as uniformDataStruct.FileUri;
            if (!fileEntry || !fileEntry.oriUri) {
              fileEntry = entryMap[UTD_FILE_URI] as uniformDataStruct.FileUri;
            }
            if (fileEntry && fileEntry.oriUri) {
              LogUtil.info(TAG, `handleDropDataFromRecordsForEntries, ${recordType} data length: ${fileEntry.oriUri.length}`);
              dropData.fileUris.push(fileEntry.oriUri);
            } else {
              let fileRecUri = this.readUriFromRecord(record);
              if (fileRecUri) {
                LogUtil.info(TAG, `handleDropDataFromRecordsForEntries, ${recordType} fallback from record, length: ${fileRecUri.length}`);
                dropData.fileUris.push(fileRecUri);
              } else {
                LogUtil.warn(TAG, `handleDropDataFromRecordsForEntries, ${recordType} has no file uri entry`);
              }
            }
            break;
          default:
            LogUtil.warn(TAG, `On handleDropDataFromRecordsForEntries dragData, type: ${recordType} not support`);
            break;
        }
      })
    })
    LogUtil.info(TAG, `handleDropDataFromRecordsForEntries, fileUris size: ${dropData.fileUris.length}`);
  }

  /**
   * Last-resort uri read: legacy UDC records (new UDC.File()/new UDC.Image())
   * may surface with an empty entry map, keeping the uri on the record body.
   */
  private readUriFromRecord(record: UDC.UnifiedRecord): string {
    let recordType = record.getType();
    if (recordType === UTD.UniformDataType.IMAGE) {
      let imageRecord = record as unifiedDataChannel.Image;
      if (imageRecord && imageRecord.imageUri) {
        return imageRecord.imageUri;
      }
    }
    let fileRecord = record as unifiedDataChannel.File;
    return (fileRecord && fileRecord.uri) ? fileRecord.uri : "";
  }

  private handleTextDragDataForEntries(dragParams: OhosDragParamToJs) {
    let plainText : uniformDataStruct.PlainText|undefined = undefined;
    if (dragParams.text) {
      LogUtil.info(TAG, `handleDragDataForEntries text-length:${dragParams.text.length}`);
      plainText = {
        uniformDataType : uniformTypeDescriptor.UniformDataType.PLAIN_TEXT,
        textContent:dragParams.text
      }
    }
    return plainText;
  }

  private handleHtmlDragDataForEntries(dragParams: OhosDragParamToJs) {
    let html : uniformDataStruct.HTML|undefined = undefined;
    if (dragParams.html) {
      LogUtil.info(TAG, `handleDragDataForEntries html-length:${dragParams.html.length}`);
      html = {
        uniformDataType: uniformTypeDescriptor.UniformDataType.HTML,
        htmlContent: dragParams.html
      }
      if (dragParams.text) {
        html.plainContent = dragParams.text;
      }
    }
    return html;
  }

  private handleHyperlinkDragDataForEntries(dragParams: OhosDragParamToJs) {
    let hyperlink : uniformDataStruct.Hyperlink|undefined = undefined;
    if (dragParams.urlTitle) {
      LogUtil.info(TAG, `handleDragDataForEntries urlTitle-length:${dragParams.urlTitle.length}`);
      hyperlink = {
        uniformDataType: uniformTypeDescriptor.UniformDataType.HYPERLINK,
        url: "",
        description: dragParams.urlTitle
      }
    }
    if (dragParams.url) {
      LogUtil.info(TAG, `handleDragDataForEntries url-length:${dragParams.url.length}`);
      if (hyperlink !== undefined) {
        hyperlink.url = dragParams.url;
      } else {
        hyperlink = {
          uniformDataType: uniformTypeDescriptor.UniformDataType.HYPERLINK,
          url: dragParams.url,
          description: dragParams.urlTitle
        }
      }
    }
    return hyperlink;
  }

  private handleWebImageForEntries(dragParams: OhosDragParamToJs) {
    let dragImage : uniformDataStruct.FileUri|undefined = undefined;
    if (dragParams.webImageFilePath) {
      LogUtil.info(TAG, `handleDragDataForEntries webImageFilePath-length:${dragParams.webImageFilePath.length}`);
      let image: UDC.Image | undefined = this.handleImageDragUri(dragParams.webImageFilePath);
      if (image) {
        dragImage = {
          uniformDataType: UTD_FILE_URI,
          oriUri: image.imageUri,
          fileType: UTD.UniformDataType.IMAGE
        }
        LogUtil.info(TAG, `handleDragDataForEntries oriUri-length:${dragImage.oriUri.length}`);
      }
    }
    return dragImage;
  }

  private handleBookmarkDragDataForEntries(dragParams: OhosDragParamToJs) {
    let bookmarkStruct: CustomDragData|undefined = undefined;
    if (dragParams.bookmarkBuffer?.byteLength > 0) {
      LogUtil.info(TAG, `handleDragDataForEntries bookmarkBuffer-length:${dragParams.bookmarkBuffer?.byteLength}`);
      bookmarkStruct = {
        uniformDataType: BOOKMARK_DEFINED_TYPE,
        bufferData: dragParams.bookmarkBuffer,
      }
    }
    return bookmarkStruct;
  }

  private handleWebCustomDataForEntries(dragParams: OhosDragParamToJs) {
    let webCustomStruct: CustomDragData|undefined = undefined;
    if (dragParams.webCustomBuffer?.byteLength > 0) {
      LogUtil.info(TAG, `handleDragDataForEntries webCustomBuffer-length:${dragParams.webCustomBuffer?.byteLength}`);
      webCustomStruct = {
        uniformDataType: WEB_CUSTOM_DEFINED_TYPE,
        bufferData: dragParams.webCustomBuffer,
      }
    }
    return webCustomStruct;
  }

  private handleImageDragUri(webImageFilePath: string) : UDC.Image | undefined {
    if (!webImageFilePath) {
      LogUtil.error(TAG, `get drag image info fail, webImageFilePath is empty`);
      return;
    }
    try {
      let res: boolean = fs.accessSync(webImageFilePath);
      if (!res) {
        LogUtil.error(TAG, `get drag image info failed, image not exists`);
        return;
      }
      let uri: string = fileUri.getUriFromPath(webImageFilePath);
      let image: UDC.Image = new UDC.Image();
      image.imageUri = uri;
      return image;
    } catch(err) {
      LogUtil.error(TAG, `get drag image info failed with error message: ${err.message},
                    error code: ${err.code}`);
    }
    return;
  }

  private handleFileDragUri(FileUri: string): UDC.File | undefined {
    if (!FileUri) {
      LogUtil.error(TAG, `get drag file info fail, FileUri is empty`);
      return;
    }
    try {
      let res: boolean = fs.accessSync(FileUri);
      if (!res) {
        LogUtil.error(TAG, `get drag file info failed, file not exists`);
        return;
      }
      let uri: string = fileUri.getUriFromPath(FileUri);
      let file: UDC.File = new UDC.File();
      file.uri = uri;
      return file;
    } catch(err) {
      LogUtil.error(TAG, `get drag file info failed with error message: ${err.message},
                    error code: ${err.code}`);
    }
    return;
  }

  private loadApplicationDefineData(dropData: OhosDropData) {
    let applicationDefinedItem = this.getRecord(APPLICATION_DEFINE_TYPE) as UDC.ApplicationDefinedRecord;
    if (!applicationDefinedItem) {
      LogUtil.error(TAG, 'loadApplicationDefineData,APPLICATION_DEFINE_TYPE:item undefined');
      return;
    }
    if (applicationDefinedItem.rawData.byteLength > 0) {
      if (applicationDefinedItem.applicationDefinedType === BOOKMARK_DEFINED_TYPE) {
        dropData.bookmarkBuffer = applicationDefinedItem.rawData;
        LogUtil.info(TAG, `loadApplicationDefineData, bookmarkBuffer data length: ${dropData.bookmarkBuffer?.byteLength}`);
      } else if (applicationDefinedItem.applicationDefinedType === WEB_CUSTOM_DEFINED_TYPE) {
        dropData.webCustomBuffer = applicationDefinedItem.rawData;
        LogUtil.info(TAG, `loadApplicationDefineData, webCustomBuffer data length: ${dropData.webCustomBuffer?.byteLength}`);
      } else {
        LogUtil.warn(TAG, `On loadApplicationDefineData dragData,
            APPLICATION_DEFINE_TYPE: ${applicationDefinedItem.applicationDefinedType} not support`);
      }
    }
  }

  private loadApplicationDefineDataForEntries(applicationType: string): ArrayBuffer | undefined{
    let applicationDefinedItem = this.getRecordForEntries(applicationType) as CustomDragData;
    if (!applicationDefinedItem) {
      LogUtil.error(TAG, `loadApplicationDefineDataForEntries, type:${applicationType} do not find data`);
      return undefined;
    }
    if (applicationDefinedItem.bufferData.byteLength > 0) {
      LogUtil.info(TAG, `loadApplicationDefineDataForEntries, type: ${applicationType},
                        data length: ${applicationDefinedItem.bufferData.byteLength}`);
      return applicationDefinedItem.bufferData;
    }
    return undefined;
  }

  private getRecord(recordType: string) : UDC.UnifiedRecord | undefined {
    if (!this.dragData) {
      return;
    }
    let records = this.dragData.getRecords();
    for (let i = 0; i < records.length; i++) {
      if (records[i].getType() === recordType) {
        return records[i];
      }
    }
    return;
  }

  private getRecordForEntries(entryType: string) : uniformDataStruct.FileUri | CustomDragData | undefined {
    if (!this.dragData || this.dragData.getRecords().length == 0) {
      return;
    }
    // In the case of multiple entries, there is only one record
    let entryMap = this.dragData.getRecords()[0].getEntries();
    return entryMap[entryType] as CustomDragData | uniformDataStruct.FileUri | undefined;
  }

  public clearParam() : void {
    this.dragData = undefined;
  }
};
