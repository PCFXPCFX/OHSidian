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

import { inject, injectable } from 'inversify';
import dragController from "@ohos.arkui.dragController"
import { deviceInfo } from '@kit.BasicServicesKit';
import image from '@ohos.multimedia.image';
import UDC from '@ohos.data.unifiedDataChannel';
import { AbilityManager } from '../common/AbilityManager';
import { BaseAdapter } from '../common/BaseAdapter';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';
import { OhosDragParamToJs, OhosDropData } from '../interface/CommonInterface';
import lazy { DragParamManager } from '../common/DragParamManager';
import { SystemFloatingWindowManager } from '../common/SystemFloatingWindowManager';
import lazy { ContextAdapter } from './ContextAdapter';

const TAG: string = 'OhosDrag';

@injectable()
export class DragDropAdapter extends BaseAdapter {
  private pixmap: image.PixelMap | undefined = undefined

  private abilityManager: AbilityManager;
  private systemFloatingWindowManager: SystemFloatingWindowManager;
  private dragSourceWindowId: string = "";
  private dragParamManager: DragParamManager;
  private ctxAdapter: ContextAdapter;

  constructor(
    @inject(DragParamManager) manager: DragParamManager,
    @inject(AbilityManager) abilityManager: AbilityManager,
    @inject(SystemFloatingWindowManager) systemFloatingWindowManager: SystemFloatingWindowManager,
    @inject(ContextAdapter) ctxAdapter: ContextAdapter,
  ) {
    super();
    this.dragParamManager = manager;
    this.abilityManager = abilityManager;
    this.systemFloatingWindowManager = systemFloatingWindowManager;
    this.ctxAdapter = ctxAdapter;
  }

  @LogMethod
  async startDrag(dragParams: OhosDragParamToJs) {
    this.dragSourceWindowId = dragParams.windowId;
    if (dragParams.pixelMapTouchX > dragParams.pixelMapWidth
        || dragParams.pixelMapTouchY > dragParams.pixelMapHeight) {
      LogUtil.error(TAG, `startDrag fail: touch point param is invalid, 
                    touchX:${dragParams.pixelMapTouchX},
                    touchY:${dragParams.pixelMapTouchY}, 
                    width:${dragParams.pixelMapWidth},
                    height:${dragParams.pixelMapHeight}`);
      return;
    }
    let touchX: Dimension = 
        ((dragParams.pixelMapTouchX / dragParams.pixelMapWidth) * 100 + '%') as Dimension;
    let touchY: Dimension = 
        ((dragParams.pixelMapTouchY / dragParams.pixelMapHeight) * 100 + '%') as Dimension;
    let unifiedData: UDC.UnifiedData | undefined;
    if (deviceInfo.sdkApiVersion >= 15) {
      unifiedData = this.dragParamManager.handleDragDataForEntries(dragParams);
    } else {
      unifiedData = this.dragParamManager.handleDragRecords(dragParams);
    }
    let dragInfo: dragController.DragInfo = {
      pointerId: 0,
      data: unifiedData,
      extraParams: '',
      previewOptions: {numberBadge: false, mode: DragPreviewMode.DISABLE_SCALE},
      touchPoint: {
        x: touchX,
        y: touchY
      }
    }

    let opts: image.InitializationOptions = {
      editable: false,
      pixelFormat: image.PixelMapFormat.BGRA_8888,
      size: {
        height: dragParams.pixelMapHeight,
        width: dragParams.pixelMapWidth
      }
    }
    try {
      this.pixmap = await image.createPixelMap(dragParams.pixelMapBuffer, opts);
    } catch (error) {
      LogUtil.error(TAG, `pixelmap create fail :${JSON.stringify(error)}`);
      return;
    }
    let dragItemInfo: DragItemInfo = {
      pixelMap: this.pixmap,
      builder: ()=>{},
      extraInfo: "ohosDrag"
    }
    this.executeDragAction(dragItemInfo, dragInfo);
  }

  private executeDragAction(dragItemInfo: DragItemInfo, dragInfo: dragController.DragInfo) {
    let uiContext = this.dragParamManager.getUiContext(this.dragSourceWindowId);
    if (!uiContext) {
      this.clearDragParam();
      LogUtil.error(TAG, `executeDrag fail : uiContext not exist`);
      return;
    }
    try {
      let customBuilders = new Array<CustomBuilder | DragItemInfo>();
      customBuilders.push(dragItemInfo);
      let dragAction = uiContext.getDragController().createDragAction(customBuilders, dragInfo);
      if (!dragAction) {
        this.clearDragParam();
        LogUtil.error(TAG, `dragAction create fail`);
        return;
      }
      dragAction.on('statusChange', this.dragActionStatusListener(dragAction));
      dragAction.startDrag().catch((err: Error) => {
        this.clearDragParam();
        LogUtil.error(TAG, `dragAction startDrag fail :${JSON.stringify(err)}`);
      })
    } catch(err) {
      this.clearDragParam();
      LogUtil.error(TAG, `dragAction fail :${JSON.stringify(err)}`);
    }
  }

  dragEnterData(xComponentId: string, summary: Summary) {
    let dropData = this.dragParamManager.handleDropDataForEnter(summary);
    this.nativeContext.OnDragEnterCB(xComponentId, dropData, dropData.fileUris);
  }

  dragMove(id: string, windowX: number, windowY: number): void {
    let windowClass = this.abilityManager.getProxy(id)?.getWindow();
    if (!windowClass) {
      windowClass = this.systemFloatingWindowManager.getWindow(id);
    }
    try {
      const mainWindowProp = windowClass?.getWindowProperties();
      let xComBorder: number = mainWindowProp?.drawableRect.left || 0;
      let xComTop: number = mainWindowProp?.drawableRect.top || 0;
      windowX -= xComBorder;
      windowY -= xComTop;
      this.nativeContext.OnDragMoveCB(id, windowX, windowY);
    } catch (err) {
      LogUtil.error(TAG, 'Failed to obtain window properties:' + JSON.stringify(err));
    }
  }

  dragLeave(xComponentId: string) {
    this.nativeContext.OnDragLeaveCB(xComponentId);
  }

  async dropData(xComponentId: string, dragData: UnifiedData) {
    // dragSourceWindowId is only set while THIS app drives the drag; external
    // sources (中转站, 文件管理器, 碰一碰) arrive with it empty.
    let isLocalDrag = this.dragSourceWindowId !== "";
    let dropData = this.dragParamManager.handleDropDataForDrop(dragData, isLocalDrag);
    if (!isLocalDrag) {
      try {
        dropData = await this.dragParamManager.sanitizeExternalDropData(dropData, this.cacheDir());
      } catch (err) {
        LogUtil.error(TAG, `dropData sanitize failed, drop raw data: ${JSON.stringify(err)}`);
      }
    }
    this.nativeContext.OnDropCB(xComponentId, dropData, dropData.fileUris);
  }

  /**
   * Entry point for content arriving OUTSIDE the drag event flow (碰一碰
   * deliveries, share-target Wants, future cross-device transfers). Copies
   * unreadable source files into the app cache and dispatches a drop into
   * the focused editor window, exactly like a system drag drop.
   * @param xComponentId target editor window; empty = currently active window
   */
  @LogMethod
  async ingestExternalContent(xComponentId: string, fileUris: Array<string>, text: string, html: string): Promise<void> {
    let target = (xComponentId && xComponentId.length > 0) ? xComponentId : this.ctxAdapter.getActiveWindow();
    if (!target || target.length === 0) {
      LogUtil.error(TAG, `ingestExternalContent fail: no target window`);
      return;
    }
    let dropData: OhosDropData = {
      text: text ? text : "",
      url: "",
      urlTitle: "",
      html: html ? html : "",
      fileUris: fileUris ? fileUris : [],
      bookmarkBuffer: new ArrayBuffer(0),
      webCustomBuffer: new ArrayBuffer(0)
    };
    try {
      dropData = await this.dragParamManager.sanitizeExternalDropData(dropData, this.cacheDir());
    } catch (err) {
      LogUtil.error(TAG, `ingestExternalContent sanitize failed, drop raw data: ${JSON.stringify(err)}`);
    }
    // The engine only materializes a renderer drop for a window with an
    // ACTIVE drag session: a bare OnDropCB without a preceding enter/move is
    // silently ignored (observed 2026-10-01: a share ingestion copied the
    // file and dispatched, but the editor never saw a drop). Replay the
    // sequence a real system drag produces, aiming at the editor area
    // (center of the window's drawable region).
    LogUtil.info(TAG, `ingestExternalContent, dispatch drag session into window ${target}, files: ${dropData.fileUris.length}`);
    this.nativeContext.OnDragEnterCB(target, dropData, dropData.fileUris);
    let center = this.drawableCenter(target);
    if (center) {
      await this.delay(80);
      this.nativeContext.OnDragMoveCB(target, center[0], center[1]);
      LogUtil.info(TAG, `ingestExternalContent, dragmove ${center[0]},${center[1]}`);
    }
    await this.delay(120);
    this.nativeContext.OnDropCB(target, dropData, dropData.fileUris);
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  // Center of the window's drawable region in surface px - the coordinate
  // space OnDragMoveCB receives from the real drag path (vp2px(windowX)
  // minus the drawable offset).
  private drawableCenter(id: string): Array<number> | undefined {
    try {
      let windowClass = this.abilityManager.getProxy(id)?.getWindow()
        ?? this.systemFloatingWindowManager.getWindow(id);
      let prop = windowClass?.getWindowProperties();
      let drawable = prop?.drawableRect;
      if (drawable && drawable.width > 0 && drawable.height > 0) {
        return [Math.floor(drawable.width / 2), Math.floor(drawable.height / 2)];
      }
      let rect = prop?.windowRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        return [Math.floor(rect.width / 2), Math.floor(rect.height / 2)];
      }
    } catch (err) {
      LogUtil.warn(TAG, `drawableCenter failed: ${JSON.stringify(err)}`);
    }
    return undefined;
  }

  private cacheDir(): string {
    try {
      let dir = this.ctxAdapter.getContext().cacheDir;
      return dir ? dir : "";
    } catch (err) {
      LogUtil.warn(TAG, `cacheDir unavailable: ${JSON.stringify(err)}`);
      return "";
    }
  }

  private dragActionStatusListener(dragAction: dragController.DragAction) {
    return (dragAndDropInfo: dragController.DragAndDropInfo) => {
      if (dragAndDropInfo.status === dragController.DragStatus.ENDED) {
        if (dragAction) {
          dragAction.off('statusChange');
        }
        this.nativeContext.OnDragEndCB(this.dragSourceWindowId);
        this.clearDragParam();
      }
    };
  }

  private clearDragParam() {
    if (this.pixmap) {
      this.pixmap.release().catch((err: Error) => {
        LogUtil.error(TAG, `pixmap release failed:${JSON.stringify(err)}`);
      })
    }
    this.dragSourceWindowId = "";
    this.dragParamManager.clearParam();
  }
}
