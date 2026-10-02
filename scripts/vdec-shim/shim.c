/*
 * libnative_media_vdec.so shim v6 (round 97) - OHSidian HEVC compat layer.
 *
 * Root cause chain (proven across rounds 95b-96k, see docs/CHANGES-2026-09.md):
 *  1. The closed-source bridge configures the decoder with width/height only;
 *     the HAL rejects it (fixed here by injecting pixel_format).
 *  2. The bridge never sets the consumer queue format; the HAL hard-wires
 *     NV12 output while the queue allocates RGBA (fixed by the queue format,
 *     but the frame factory still failed - see 3).
 *  3. The port's frame factory imports ONLY RGBA textures
 *     (CopyRGBATextureToVideoFrame; zero YUV import in the binary), so an
 *     NV12 queue still yields "Failed to create VideoFrame" and the decoder
 *     is torn down ~70ms after start.
 *
 * Round 97 compat layer: a SURFACE RELAY. SetSurface is intercepted; the
 * codec gets a private NV12 consumer queue (OH_ConsumerSurface_Create), and
 * the frame-available callback converts each decoded frame NV12->RGBA
 * (CPU, fixed-point BT.601) into the bridge's original RGBA window. The
 * bridge's frame factory then imports a correctly-filled RGBA buffer - the
 * exact configuration that rendered (garbage) in round 96g, now with
 * correct content.
 *
 * Everything else forwards 1:1 to the real system libnative_media_vdec.so
 * (dlopen by absolute path). Delete this file from the HAP to remove the
 * whole compat layer.
 */

#include <dlfcn.h>
#include <poll.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <hilog/log.h>
#include <multimedia/player_framework/native_avcodec_base.h>
#include <multimedia/player_framework/native_avcodec_videodecoder.h>
#include <multimedia/player_framework/native_avformat.h>
#include <native_buffer/native_buffer.h>
#include <native_window/external_window.h>
#include <native_image/native_image.h>

#undef LOG_DOMAIN
#undef LOG_TAG
#define LOG_DOMAIN 0x0000
#define LOG_TAG "VdecShim"

#define SHIM_LOGI(...) ((void)OH_LOG_Print(LOG_APP, LOG_INFO, LOG_DOMAIN, LOG_TAG, __VA_ARGS__))
#define SHIM_LOGE(...) ((void)OH_LOG_Print(LOG_APP, LOG_ERROR, LOG_DOMAIN, LOG_TAG, __VA_ARGS__))

/* ===== real system library ===== */
static void *gReal = NULL;

typedef OH_AVCodec *(*PFN_CreateByMime)(const char *mime);
typedef OH_AVCodec *(*PFN_CreateByName)(const char *name);
typedef OH_AVErrCode (*PFN_Destroy)(OH_AVCodec *codec);
typedef OH_AVErrCode (*PFN_SetCallback)(OH_AVCodec *codec, OH_AVCodecAsyncCallback callback, void *userData);
typedef OH_AVErrCode (*PFN_RegisterCallback)(OH_AVCodec *codec, OH_AVCodecCallback callback, void *userData);
typedef OH_AVErrCode (*PFN_SetSurface)(OH_AVCodec *codec, OHNativeWindow *window);
typedef OH_AVErrCode (*PFN_Configure)(OH_AVCodec *codec, OH_AVFormat *format);
typedef OH_AVErrCode (*PFN_Prepare)(OH_AVCodec *codec);
typedef OH_AVErrCode (*PFN_Start)(OH_AVCodec *codec);
typedef OH_AVErrCode (*PFN_Stop)(OH_AVCodec *codec);
typedef OH_AVErrCode (*PFN_Flush)(OH_AVCodec *codec);
typedef OH_AVErrCode (*PFN_Reset)(OH_AVCodec *codec);
typedef OH_AVErrCode (*PFN_SetParameter)(OH_AVCodec *codec, OH_AVFormat *format);
typedef OH_AVErrCode (*PFN_PushInputData)(OH_AVCodec *codec, uint32_t index, OH_AVCodecBufferAttr attr);
typedef OH_AVErrCode (*PFN_PushInputBuffer)(OH_AVCodec *codec, uint32_t index);
typedef OH_AVErrCode (*PFN_RenderOutputData)(OH_AVCodec *codec, uint32_t index);
typedef OH_AVErrCode (*PFN_RenderOutputBuffer)(OH_AVCodec *codec, uint32_t index);
typedef OH_AVErrCode (*PFN_FreeOutputData)(OH_AVCodec *codec, uint32_t index);
typedef OH_AVFormat *(*PFN_GetOutputDescription)(OH_AVCodec *codec);
typedef OH_AVErrCode (*PFN_IsValid)(OH_AVCodec *codec, bool *isValid);
typedef bool (*PFN_FormatGetIntValue)(OH_AVFormat *format, const char *key, int32_t *out);
typedef bool (*PFN_FormatSetIntValue)(OH_AVFormat *format, const char *key, int32_t value);

static PFN_CreateByMime gCreateByMime;
static PFN_CreateByName gCreateByName;
static PFN_Destroy gDestroy;
static PFN_SetCallback gSetCallback;
static PFN_RegisterCallback gRegisterCallback;
static PFN_SetSurface gSetSurface;
static PFN_Configure gConfigure;
static PFN_Prepare gPrepare;
static PFN_Start gStart;
static PFN_Stop gStop;
static PFN_Flush gFlush;
static PFN_Reset gReset;
static PFN_SetParameter gSetParameter;
static PFN_PushInputData gPushInputData;
static PFN_PushInputBuffer gPushInputBuffer;
static PFN_RenderOutputData gRenderOutputData;
static PFN_RenderOutputBuffer gRenderOutputBuffer;
static PFN_FreeOutputData gFreeOutputData;
static PFN_GetOutputDescription gGetOutputDescription;
static PFN_IsValid gIsValid;
static PFN_FormatGetIntValue gGetIntValue;
static PFN_FormatSetIntValue gSetIntValue;

/* ===== graphics libs (resolved by plain soname; the app namespace resolves
   them the same way it resolved libnative_media_core.so) ===== */
static void *gCore = NULL;
static bool gCoreTried = false;
static void *gImgLib = NULL;
static void *gWinLib = NULL;
static void *gBufLib = NULL;

typedef int32_t (*PFN_WindowOpt)(OHNativeWindow *window, int code, ...);
typedef int32_t (*PFN_ReqBuffer)(OHNativeWindow *window, OHNativeWindowBuffer **buffer, int *fenceFd);
typedef int32_t (*PFN_FlushBuffer)(OHNativeWindow *window, OHNativeWindowBuffer *buffer, int fenceFd, Region region);
typedef int32_t (*PFN_FromNWB)(OHNativeWindowBuffer *nativeWindowBuffer, OH_NativeBuffer **buffer);
typedef int32_t (*PFN_NBMapPlanes)(OH_NativeBuffer *buffer, void **virAddr, OH_NativeBuffer_Planes *outPlanes);
typedef int32_t (*PFN_NBMap)(OH_NativeBuffer *buffer, void **virAddr);
typedef int32_t (*PFN_NBUnmap)(OH_NativeBuffer *buffer);
typedef OH_NativeImage *(*PFN_ConsumerCreate)(void);
typedef OHNativeWindow *(*PFN_ImageAcqWin)(OH_NativeImage *image);
typedef int32_t (*PFN_ImageAcqBuf)(OH_NativeImage *image, OHNativeWindowBuffer **nativeWindowBuffer, int *fenceFd);
typedef int32_t (*PFN_ImageRelBuf)(OH_NativeImage *image, OHNativeWindowBuffer *nativeWindowBuffer, int fenceFd);
typedef int32_t (*PFN_ImageSetListener)(OH_NativeImage *image, OH_OnFrameAvailableListener listener);
typedef void (*PFN_ImageDestroy)(OH_NativeImage **image);

static PFN_WindowOpt gHandleOpt;
static PFN_ReqBuffer gReqBuffer;
static PFN_FlushBuffer gFlushBuffer;
static PFN_FromNWB gFromNWB;
static PFN_NBMapPlanes gMapPlanes;
static PFN_NBMap gMap;
static PFN_NBUnmap gUnmap;
static PFN_ConsumerCreate gConsumerCreate;
static PFN_ImageAcqWin gImageAcqWin;
static PFN_ImageAcqBuf gImageAcqBuf;
static PFN_ImageRelBuf gImageRelBuf;
static PFN_ImageSetListener gImageSetListener;
static PFN_ImageDestroy gImageDestroy;

static void *coreSym(const char *name)
{
    if (!gCoreTried) {
        gCoreTried = true;
        gCore = dlopen("libnative_media_core.so", RTLD_NOW | RTLD_LOCAL);
        if (gCore == NULL) {
            SHIM_LOGE("real core dlopen failed: %{public}s", dlerror());
        }
    }
    return gCore ? dlsym(gCore, name) : NULL;
}

static void *libSym(void **handle, const char *soname, const char *name)
{
    if (*handle == NULL) {
        *handle = dlopen(soname, RTLD_NOW | RTLD_LOCAL);
        if (*handle == NULL) {
            SHIM_LOGE("%{public}s dlopen failed: %{public}s", soname, dlerror());
            return NULL;
        }
    }
    void *sym = dlsym(*handle, name);
    if (sym == NULL) {
        SHIM_LOGE("dlsym %{public}s failed: %{public}s", name, dlerror());
    }
    return sym;
}

/* ===== relay state (single active video surface; the first decoder that
   reaches SetSurface claims it - matches the one-playing-video case; extra
   decoders keep the old direct path) ===== */
static pthread_mutex_t gRelayLock = PTHREAD_MUTEX_INITIALIZER;
static OHNativeWindow *gOrigWin = NULL;
static OH_NativeImage *gConsumer = NULL;
static OH_AVCodec *gRelayCodec = NULL;
static int gRelayW = 0;
static int gRelayH = 0;
static int gGeomSet = 0;
static int gRelayActive = 0;
static long gRelayFrames = 0;

/* per-codec configured size (Configure happens before SetSurface; a tiny
   ring handles the multi-decoder pages) */
#define CFG_SLOTS 8
typedef struct {
    OH_AVCodec *codec;
    int w;
    int h;
} CfgEntry;
static CfgEntry gCfg[CFG_SLOTS];
static int gCfgN = 0;

static void cfgRecord(OH_AVCodec *codec, int w, int h)
{
    for (int i = 0; i < gCfgN; i++) {
        if (gCfg[i].codec == codec) {
            gCfg[i].w = w;
            gCfg[i].h = h;
            return;
        }
    }
    if (gCfgN < CFG_SLOTS) {
        gCfg[gCfgN].codec = codec;
        gCfg[gCfgN].w = w;
        gCfg[gCfgN].h = h;
        gCfgN++;
    }
}

static int cfgLookup(OH_AVCodec *codec, int *w, int *h)
{
    for (int i = 0; i < gCfgN; i++) {
        if (gCfg[i].codec == codec) {
            *w = gCfg[i].w;
            *h = gCfg[i].h;
            return 1;
        }
    }
    return 0;
}

static void cfgDrop(OH_AVCodec *codec)
{
    for (int i = 0; i < gCfgN; i++) {
        if (gCfg[i].codec == codec) {
            gCfg[i] = gCfg[gCfgN - 1];
            gCfgN--;
            return;
        }
    }
}

/* ===== NV12 -> RGBA conversion, fixed-point BT.601 (libyuv-equivalent
   coefficients). dst is RGBA byte order (R at byte 0) to match an
   RGBA8888 shared image sampled by the compositor. ===== */
static inline uint8_t clamp8(int v)
{
    if (v < 0) return 0;
    if (v > 255) return 255;
    return (uint8_t)v;
}

static void nv12ToRgba(uint8_t *dst, int dstStrideBytes,
    const uint8_t *yPlane, int yStride,
    const uint8_t *uvPlane, int uvStride,
    int width, int height)
{
    for (int y = 0; y < height; y++) {
        const uint8_t *yRow = yPlane + (size_t)y * yStride;
        const uint8_t *uvRow = uvPlane + (size_t)(y >> 1) * uvStride;
        uint8_t *dRow = dst + (size_t)y * dstStrideBytes;
        for (int x = 0; x < width; x++) {
            int Y = yRow[x];
            int U = uvRow[(x & ~1)];
            int V = uvRow[(x & ~1) + 1];
            dRow[x * 4 + 0] = clamp8((298 * Y + 409 * V + 128) >> 8);
            dRow[x * 4 + 1] = clamp8((298 * Y - 100 * U - 208 * V + 128) >> 8);
            dRow[x * 4 + 2] = clamp8((298 * Y + 516 * U + 128) >> 8);
            dRow[x * 4 + 3] = 255;
        }
    }
}

/* Query the codec's reported stride / slice height from
   GetOutputDescription (round 97b fix: this buffer's GetImageLayout is
   unsupported, so MapPlanes cannot provide the layout - compute the NV12
   geometry from the values the decoder itself publishes). */
static int queryFmtInt(const char *key, int fallback)
{
    int v = fallback;
    if (gRelayCodec != NULL && gGetOutputDescription != NULL && gGetIntValue != NULL) {
        OH_AVFormat *fmt = gGetOutputDescription(gRelayCodec);
        if (fmt != NULL) {
            int32_t got = 0;
            if (gGetIntValue(fmt, key, &got) && got > 0) {
                v = (int)got;
            }
        }
    }
    return v;
}

static void waitFence(int fd)
{
    if (fd < 0) return;
    struct pollfd p;
    p.fd = fd;
    p.events = POLLIN;
    (void)poll(&p, 1, 300);
}

/* Per-frame relay: runs on the consumer's frame-available thread. */
static void relayOnFrame(void *context)
{
    (void)context;
    if (!gRelayActive || gOrigWin == NULL || gConsumer == NULL) {
        return;
    }
    OHNativeWindowBuffer *srcWinBuf = NULL;
    int srcFence = -1;
    if (gImageAcqBuf(gConsumer, &srcWinBuf, &srcFence) != 0 || srcWinBuf == NULL) {
        return;
    }
    OH_NativeBuffer *srcNB = NULL;
    if (gFromNWB == NULL || gFromNWB(srcWinBuf, &srcNB) != 0 || srcNB == NULL) {
        gImageRelBuf(gConsumer, srcWinBuf, srcFence);
        return;
    }
    waitFence(srcFence);

    /* Plane layout, two paths (round 97c): MapPlanes when the buffer
       carries layout metadata; otherwise plain Map + the NV12 geometry
       the decoder publishes in its output format (stride /
       video_slice_height - device dump shows stride==width,
       slice==height, UV directly after Y). */
    void *srcVir = NULL;
    OH_NativeBuffer_Planes srcPlanes;
    memset(&srcPlanes, 0, sizeof(srcPlanes));
    const uint8_t *yPlane = NULL;
    const uint8_t *uvPlane = NULL;
    int yStride = 0;
    int uvStride = 0;
    int srcMapped = 0;
    if (gMapPlanes(srcNB, &srcVir, &srcPlanes) == 0 && srcVir != NULL &&
        srcPlanes.planeCount >= 2) {
        yPlane = (const uint8_t *)srcVir + (size_t)srcPlanes.planes[0].offset;
        uvPlane = (const uint8_t *)srcVir + (size_t)srcPlanes.planes[1].offset;
        yStride = (int)srcPlanes.planes[0].rowStride;
        uvStride = (int)srcPlanes.planes[1].rowStride;
        srcMapped = 1;
    } else if (gMap != NULL && gMap(srcNB, &srcVir) == 0 && srcVir != NULL) {
        int st = queryFmtInt("stride", gRelayW);
        int sliceH = queryFmtInt("video_slice_height", gRelayH);
        if (st < gRelayW) st = gRelayW;
        if (sliceH < gRelayH) sliceH = gRelayH;
        yPlane = (const uint8_t *)srcVir;
        uvPlane = (const uint8_t *)srcVir + (size_t)st * (size_t)sliceH;
        yStride = st;
        uvStride = st;
        srcMapped = 1;
        SHIM_LOGI("src layout via Map fallback: stride=%{public}d sliceH=%{public}d", st, sliceH);
    }
    if (!srcMapped) {
        gImageRelBuf(gConsumer, srcWinBuf, srcFence);
        return;
    }

    if (!gGeomSet && gRelayW > 0 && gRelayH > 0) {
        gHandleOpt(gOrigWin, SET_BUFFER_GEOMETRY, gRelayW, gRelayH);
        gGeomSet = 1;
    }

    OHNativeWindowBuffer *dstWinBuf = NULL;
    int dstFence = -1;
    if (gReqBuffer == NULL ||
        gReqBuffer(gOrigWin, &dstWinBuf, &dstFence) != 0 || dstWinBuf == NULL) {
        gUnmap(srcNB);
        gImageRelBuf(gConsumer, srcWinBuf, srcFence);
        return;
    }
    OH_NativeBuffer *dstNB = NULL;
    if (gFromNWB(dstWinBuf, &dstNB) != 0 || dstNB == NULL) {
        gUnmap(srcNB);
        gImageRelBuf(gConsumer, srcWinBuf, srcFence);
        return;
    }
    waitFence(dstFence);

    void *dstVir = NULL;
    OH_NativeBuffer_Planes dstPlanes;
    memset(&dstPlanes, 0, sizeof(dstPlanes));
    uint8_t *dst = NULL;
    int dstStride = 0;
    if (gMapPlanes(dstNB, &dstVir, &dstPlanes) == 0 && dstVir != NULL &&
        dstPlanes.planeCount >= 1) {
        dst = (uint8_t *)dstVir + (size_t)dstPlanes.planes[0].offset;
        dstStride = (int)dstPlanes.planes[0].rowStride;
    } else if (gMap != NULL && gMap(dstNB, &dstVir) == 0 && dstVir != NULL) {
        dst = (uint8_t *)dstVir;
        dstStride = gRelayW * 4;
    } else {
        gUnmap(srcNB);
        gImageRelBuf(gConsumer, srcWinBuf, srcFence);
        return;
    }

    nv12ToRgba(dst, dstStride, yPlane, yStride, uvPlane, uvStride,
        gRelayW, gRelayH);

    gUnmap(dstNB);
    gUnmap(srcNB);
    Region region;
    region.rects = NULL;
    region.rectNumber = 0;
    gFlushBuffer(gOrigWin, dstWinBuf, -1, region);
    gImageRelBuf(gConsumer, srcWinBuf, srcFence);
    gRelayFrames++;
    if ((gRelayFrames % 60) == 1) {
        SHIM_LOGI("relayed %{public}ld frames (%{public}dx%{public}d, rgba copy)",
            gRelayFrames, gRelayW, gRelayH);
    }
}

/* Format-key dump + fix helper (rounds 96c-96h). */
static void dumpAndFix(OH_AVFormat *format)
{
    if (format == NULL) {
        SHIM_LOGE("Configure: format is NULL");
        return;
    }
    int32_t w = 0;
    int32_t h = 0;
    int32_t pf = 0;
    int32_t profile = 0;
    bool hasW = gGetIntValue(format, OH_MD_KEY_WIDTH, &w);
    bool hasH = gGetIntValue(format, OH_MD_KEY_HEIGHT, &h);
    bool hasPf = gGetIntValue(format, OH_MD_KEY_PIXEL_FORMAT, &pf);
    bool hasProfile = gGetIntValue(format, OH_MD_KEY_PROFILE, &profile);
    SHIM_LOGI("Configure keys: width=%{public}d(has=%{public}d) height=%{public}d(has=%{public}d) "
        "pixelFormat=%{public}d(has=%{public}d) profile=%{public}d(has=%{public}d)",
        w, hasW, h, hasH, pf, hasPf, profile, hasProfile);
    if (!hasW || !hasH) {
        SHIM_LOGE("ENGINE BUG: width/height missing -> HAL will reject (nothing a key fix can do)");
        return;
    }
    if (!hasPf) {
        SHIM_LOGI("pixel_format absent -> injecting RGBA (try 1)");
        gSetIntValue(format, OH_MD_KEY_PIXEL_FORMAT, AV_PIXEL_FORMAT_RGBA);
    }
}

static void *realSym(void *handle, const char *name)
{
    void *sym = dlsym(handle, name);
    if (sym == NULL) {
        SHIM_LOGE("dlsym %{public}s failed: %{public}s", name, dlerror());
    }
    return sym;
}

__attribute__((constructor)) static void shimInit(void)
{
    SHIM_LOGI("shim v6 loaded - surface-relay compat layer (round 97)");
    gReal = dlopen("/system/lib64/libnative_media_vdec.so", RTLD_NOW | RTLD_LOCAL);
    if (gReal == NULL) {
        SHIM_LOGE("FATAL: real libnative_media_vdec.so dlopen failed: %{public}s", dlerror());
        return;
    }
    gCreateByMime = (PFN_CreateByMime)realSym(gReal, "OH_VideoDecoder_CreateByMime");
    gCreateByName = (PFN_CreateByName)realSym(gReal, "OH_VideoDecoder_CreateByName");
    gDestroy = (PFN_Destroy)realSym(gReal, "OH_VideoDecoder_Destroy");
    gSetCallback = (PFN_SetCallback)realSym(gReal, "OH_VideoDecoder_SetCallback");
    gRegisterCallback = (PFN_RegisterCallback)realSym(gReal, "OH_VideoDecoder_RegisterCallback");
    gSetSurface = (PFN_SetSurface)realSym(gReal, "OH_VideoDecoder_SetSurface");
    gConfigure = (PFN_Configure)realSym(gReal, "OH_VideoDecoder_Configure");
    gPrepare = (PFN_Prepare)realSym(gReal, "OH_VideoDecoder_Prepare");
    gStart = (PFN_Start)realSym(gReal, "OH_VideoDecoder_Start");
    gStop = (PFN_Stop)realSym(gReal, "OH_VideoDecoder_Stop");
    gFlush = (PFN_Flush)realSym(gReal, "OH_VideoDecoder_Flush");
    gReset = (PFN_Reset)realSym(gReal, "OH_VideoDecoder_Reset");
    gSetParameter = (PFN_SetParameter)realSym(gReal, "OH_VideoDecoder_SetParameter");
    gPushInputData = (PFN_PushInputData)realSym(gReal, "OH_VideoDecoder_PushInputData");
    gPushInputBuffer = (PFN_PushInputBuffer)realSym(gReal, "OH_VideoDecoder_PushInputBuffer");
    gRenderOutputData = (PFN_RenderOutputData)realSym(gReal, "OH_VideoDecoder_RenderOutputData");
    gRenderOutputBuffer = (PFN_RenderOutputBuffer)realSym(gReal, "OH_VideoDecoder_RenderOutputBuffer");
    gFreeOutputData = (PFN_FreeOutputData)realSym(gReal, "OH_VideoDecoder_FreeOutputData");
    gGetOutputDescription = (PFN_GetOutputDescription)realSym(gReal, "OH_VideoDecoder_GetOutputDescription");
    gIsValid = (PFN_IsValid)realSym(gReal, "OH_VideoDecoder_IsValid");
    gGetIntValue = (PFN_FormatGetIntValue)coreSym("OH_AVFormat_GetIntValue");
    gSetIntValue = (PFN_FormatSetIntValue)coreSym("OH_AVFormat_SetIntValue");
    gHandleOpt = (PFN_WindowOpt)libSym(&gWinLib, "libnative_window.so",
        "OH_NativeWindow_NativeWindowHandleOpt");
    gReqBuffer = (PFN_ReqBuffer)libSym(&gWinLib, "libnative_window.so",
        "OH_NativeWindow_NativeWindowRequestBuffer");
    gFlushBuffer = (PFN_FlushBuffer)libSym(&gWinLib, "libnative_window.so",
        "OH_NativeWindow_NativeWindowFlushBuffer");
    gFromNWB = (PFN_FromNWB)libSym(&gBufLib, "libnative_buffer.so",
        "OH_NativeBuffer_FromNativeWindowBuffer");
    gMapPlanes = (PFN_NBMapPlanes)libSym(&gBufLib, "libnative_buffer.so",
        "OH_NativeBuffer_MapPlanes");
    gMap = (PFN_NBMap)libSym(&gBufLib, "libnative_buffer.so",
        "OH_NativeBuffer_Map");
    gUnmap = (PFN_NBUnmap)libSym(&gBufLib, "libnative_buffer.so",
        "OH_NativeBuffer_Unmap");
    gConsumerCreate = (PFN_ConsumerCreate)libSym(&gImgLib, "libnative_image.so",
        "OH_ConsumerSurface_Create");
    gImageAcqWin = (PFN_ImageAcqWin)libSym(&gImgLib, "libnative_image.so",
        "OH_NativeImage_AcquireNativeWindow");
    gImageAcqBuf = (PFN_ImageAcqBuf)libSym(&gImgLib, "libnative_image.so",
        "OH_NativeImage_AcquireNativeWindowBuffer");
    gImageRelBuf = (PFN_ImageRelBuf)libSym(&gImgLib, "libnative_image.so",
        "OH_NativeImage_ReleaseNativeWindowBuffer");
    gImageSetListener = (PFN_ImageSetListener)libSym(&gImgLib, "libnative_image.so",
        "OH_NativeImage_SetOnFrameAvailableListener");
    gImageDestroy = (PFN_ImageDestroy)libSym(&gImgLib, "libnative_image.so",
        "OH_NativeImage_Destroy");
    SHIM_LOGI("symbols: configure=%{public}d getfmt=%{public}d handleopt=%{public}d "
        "consumer=%{public}d acqbuf=%{public}d mapplanes=%{public}d",
        gConfigure != NULL, gGetIntValue != NULL, gHandleOpt != NULL,
        gConsumerCreate != NULL, gImageAcqBuf != NULL, gMapPlanes != NULL);
}

/* ===== Exported forwards ===== */

OH_AVCodec *OH_VideoDecoder_CreateByMime(const char *mime)
{
    OH_AVCodec *codec = gCreateByMime ? gCreateByMime(mime) : NULL;
    SHIM_LOGI("CreateByMime(%{public}s) -> %{public}s", mime != NULL ? mime : "(null)",
        codec != NULL ? "ok" : "NULL");
    return codec;
}

OH_AVCodec *OH_VideoDecoder_CreateByName(const char *name)
{
    return gCreateByName ? gCreateByName(name) : NULL;
}

OH_AVErrCode OH_VideoDecoder_Destroy(OH_AVCodec *codec)
{
    pthread_mutex_lock(&gRelayLock);
    if (gRelayActive && codec == gRelayCodec) {
        gRelayActive = 0;
        pthread_mutex_unlock(&gRelayLock);
        /* let an in-flight frame callback finish before tearing the queue
           down (the callback thread may be mid-conversion) */
        usleep(120000);
        pthread_mutex_lock(&gRelayLock);
        if (gConsumer != NULL && gImageDestroy != NULL) {
            gImageDestroy(&gConsumer);
        }
        gConsumer = NULL;
        gOrigWin = NULL;
        gRelayCodec = NULL;
        gGeomSet = 0;
        SHIM_LOGI("relay torn down with codec");
    }
    cfgDrop(codec);
    pthread_mutex_unlock(&gRelayLock);
    return gDestroy ? gDestroy(codec) : AV_ERR_UNKNOWN;
}

OH_AVErrCode OH_VideoDecoder_SetCallback(OH_AVCodec *codec, OH_AVCodecAsyncCallback callback, void *userData)
{
    return gSetCallback ? gSetCallback(codec, callback, userData) : AV_ERR_UNKNOWN;
}

OH_AVErrCode OH_VideoDecoder_RegisterCallback(OH_AVCodec *codec, OH_AVCodecCallback callback, void *userData)
{
    return gRegisterCallback ? gRegisterCallback(codec, callback, userData) : AV_ERR_UNKNOWN;
}

OH_AVErrCode OH_VideoDecoder_SetSurface(OH_AVCodec *codec, OHNativeWindow *window)
{
    if (window == NULL || gConsumerCreate == NULL || gImageAcqWin == NULL ||
        gImageSetListener == NULL || gMapPlanes == NULL || gFromNWB == NULL ||
        gHandleOpt == NULL || gImageAcqBuf == NULL || gImageRelBuf == NULL ||
        gUnmap == NULL || gReqBuffer == NULL || gFlushBuffer == NULL) {
        /* graphics stack pieces unavailable - direct passthrough */
        OH_AVErrCode r0 = gSetSurface ? gSetSurface(codec, window) : AV_ERR_UNKNOWN;
        SHIM_LOGI("SetSurface(passthrough) -> %{public}d", r0);
        return r0;
    }
    pthread_mutex_lock(&gRelayLock);
    if (gRelayActive && codec == gRelayCodec) {
        /* a re-set (after Flush/Reset) must point the codec back at the
           RELAY window, or the bridge's raw RGBA queue would receive NV12 */
        OHNativeWindow *rw = gImageAcqWin(gConsumer);
        pthread_mutex_unlock(&gRelayLock);
        OH_AVErrCode r = gSetSurface ? gSetSurface(codec, rw) : AV_ERR_UNKNOWN;
        SHIM_LOGI("SetSurface(own relay window re-set) -> %{public}d", r);
        return r;
    }
    if (gRelayActive) {
        /* relay busy with another decoder (multi-video page) - the extra
           decoder keeps the direct path; this shim does not multiplex */
        pthread_mutex_unlock(&gRelayLock);
        OH_AVErrCode r = gSetSurface ? gSetSurface(codec, window) : AV_ERR_UNKNOWN;
        SHIM_LOGI("SetSurface(second decoder direct) -> %{public}d", r);
        return r;
    }
    int w = 0;
    int h = 0;
    if (!cfgLookup(codec, &w, &h) || w <= 0 || h <= 0) {
        pthread_mutex_unlock(&gRelayLock);
        OH_AVErrCode r = gSetSurface ? gSetSurface(codec, window) : AV_ERR_UNKNOWN;
        SHIM_LOGI("SetSurface(no configured size, direct) -> %{public}d", r);
        return r;
    }
    OH_NativeImage *consumer = gConsumerCreate();
    if (consumer == NULL) {
        pthread_mutex_unlock(&gRelayLock);
        SHIM_LOGE("ConsumerSurface.Create failed - direct passthrough");
        OH_AVErrCode r = gSetSurface ? gSetSurface(codec, window) : AV_ERR_UNKNOWN;
        return r;
    }
    OHNativeWindow *relayWin = gImageAcqWin(consumer);
    if (relayWin == NULL) {
        gImageDestroy(&consumer);
        pthread_mutex_unlock(&gRelayLock);
        OH_AVErrCode r = gSetSurface ? gSetSurface(codec, window) : AV_ERR_UNKNOWN;
        return r;
    }
    (void)gHandleOpt(relayWin, SET_FORMAT, (int32_t)NATIVEBUFFER_PIXEL_FMT_YCBCR_420_SP);
    /* Round 97d: request CPU-readable buffer allocation on the relay queue.
       The codec's output buffers defaulted to hardware-only usage and
       OH_NativeBuffer_Map failed (CPU conversion impossible). Adding the
       CPU usage bits at the CONSUMER side makes the queue allocate
       CPU-mappable NV12 buffers (the HAL writes NV12 content either way).
       CPU_READ_OFTEN additionally avoids remap cost per frame. */
    (void)gHandleOpt(relayWin, SET_USAGE,
        (int64_t)(NATIVEBUFFER_USAGE_CPU_READ | NATIVEBUFFER_USAGE_CPU_WRITE |
                  NATIVEBUFFER_USAGE_CPU_READ_OFTEN | NATIVEBUFFER_USAGE_MEM_DMA));
    OH_OnFrameAvailableListener listener;
    listener.context = NULL;
    listener.onFrameAvailable = relayOnFrame;
    gImageSetListener(consumer, listener);
    OH_AVErrCode r = gSetSurface ? gSetSurface(codec, relayWin) : AV_ERR_UNKNOWN;
    if (r != AV_ERR_OK) {
        SHIM_LOGE("real SetSurface(relay window) failed %{public}d - direct fallback", r);
        gImageDestroy(&consumer);
        pthread_mutex_unlock(&gRelayLock);
        OH_AVErrCode r2 = gSetSurface ? gSetSurface(codec, window) : AV_ERR_UNKNOWN;
        SHIM_LOGI("SetSurface(direct fallback) -> %{public}d", r2);
        return r2;
    }
    gRelayCodec = codec;
    gRelayW = w;
    gRelayH = h;
    gOrigWin = window;
    gConsumer = consumer;
    gGeomSet = 0;
    gRelayFrames = 0;
    gRelayActive = 1;
    pthread_mutex_unlock(&gRelayLock);
    SHIM_LOGI("relay engaged: %{public}dx%{public}d NV12 -> RGBA into bridge window", w, h);
    return r;
}

OH_AVErrCode OH_VideoDecoder_Configure(OH_AVCodec *codec, OH_AVFormat *format)
{
    dumpAndFix(format);
    OH_AVErrCode r = gConfigure ? gConfigure(codec, format) : AV_ERR_UNKNOWN;
    /* Fallback chain (round 97 fix - this was lost in the v6 rewrite):
       the queue format is decided per failed Configure call (device-proven
       re-evaluation), so walk RGBA -> SURFACE_FORMAT -> NV12 until the HAL
       accepts one. RGBA is tried first because the bridge's frame factory
       imports RGBA buffers only; SURFACE_FORMAT passes Configure but the
       HAL still emits NV12; NV12 is the layout the HAL always produces. */
    if (r != AV_ERR_OK && gSetIntValue != NULL) {
        SHIM_LOGI("Configure with RGBA failed (%{public}d) - retrying with SURFACE_FORMAT", r);
        gSetIntValue(format, OH_MD_KEY_PIXEL_FORMAT, AV_PIXEL_FORMAT_SURFACE_FORMAT);
        r = gConfigure ? gConfigure(codec, format) : AV_ERR_UNKNOWN;
        SHIM_LOGI("Configure(SURFACE_FORMAT) -> %{public}d", r);
        if (r != AV_ERR_OK) {
            SHIM_LOGI("retrying with NV12");
            gSetIntValue(format, OH_MD_KEY_PIXEL_FORMAT, AV_PIXEL_FORMAT_NV12);
            r = gConfigure ? gConfigure(codec, format) : AV_ERR_UNKNOWN;
            SHIM_LOGI("Configure(NV12) -> %{public}d", r);
        }
    }
    SHIM_LOGI("Configure -> %{public}d", r);
    if (r == AV_ERR_OK && gSetIntValue != NULL && gGetIntValue != NULL) {
        int32_t w = 0;
        int32_t h = 0;
        if (gGetIntValue(format, OH_MD_KEY_WIDTH, &w) &&
            gGetIntValue(format, OH_MD_KEY_HEIGHT, &h) && w > 0 && h > 0) {
            pthread_mutex_lock(&gRelayLock);
            cfgRecord(codec, (int)w, (int)h);
            pthread_mutex_unlock(&gRelayLock);
        }
    }
    return r;
}

OH_AVErrCode OH_VideoDecoder_Prepare(OH_AVCodec *codec)
{
    OH_AVErrCode r = gPrepare ? gPrepare(codec) : AV_ERR_UNKNOWN;
    SHIM_LOGI("Prepare -> %{public}d", r);
    return r;
}

OH_AVErrCode OH_VideoDecoder_Start(OH_AVCodec *codec)
{
    OH_AVErrCode r = gStart ? gStart(codec) : AV_ERR_UNKNOWN;
    SHIM_LOGI("Start -> %{public}d", r);
    return r;
}

OH_AVErrCode OH_VideoDecoder_Stop(OH_AVCodec *codec)
{
    return gStop ? gStop(codec) : AV_ERR_UNKNOWN;
}

OH_AVErrCode OH_VideoDecoder_Flush(OH_AVCodec *codec)
{
    return gFlush ? gFlush(codec) : AV_ERR_UNKNOWN;
}

OH_AVErrCode OH_VideoDecoder_Reset(OH_AVCodec *codec)
{
    return gReset ? gReset(codec) : AV_ERR_UNKNOWN;
}

OH_AVErrCode OH_VideoDecoder_SetParameter(OH_AVCodec *codec, OH_AVFormat *format)
{
    return gSetParameter ? gSetParameter(codec, format) : AV_ERR_UNKNOWN;
}

OH_AVErrCode OH_VideoDecoder_PushInputData(OH_AVCodec *codec, uint32_t index, OH_AVCodecBufferAttr attr)
{
    return gPushInputData ? gPushInputData(codec, index, attr) : AV_ERR_UNKNOWN;
}

OH_AVErrCode OH_VideoDecoder_PushInputBuffer(OH_AVCodec *codec, uint32_t index)
{
    return gPushInputBuffer ? gPushInputBuffer(codec, index) : AV_ERR_UNKNOWN;
}

OH_AVErrCode OH_VideoDecoder_RenderOutputData(OH_AVCodec *codec, uint32_t index)
{
    return gRenderOutputData ? gRenderOutputData(codec, index) : AV_ERR_UNKNOWN;
}

OH_AVErrCode OH_VideoDecoder_RenderOutputBuffer(OH_AVCodec *codec, uint32_t index)
{
    return gRenderOutputBuffer ? gRenderOutputBuffer(codec, index) : AV_ERR_UNKNOWN;
}

OH_AVErrCode OH_VideoDecoder_FreeOutputData(OH_AVCodec *codec, uint32_t index)
{
    return gFreeOutputData ? gFreeOutputData(codec, index) : AV_ERR_UNKNOWN;
}

OH_AVFormat *OH_VideoDecoder_GetOutputDescription(OH_AVCodec *codec)
{
    return gGetOutputDescription ? gGetOutputDescription(codec) : NULL;
}

OH_AVErrCode OH_VideoDecoder_IsValid(OH_AVCodec *codec, bool *isValid)
{
    return gIsValid ? gIsValid(codec, isValid) : AV_ERR_UNKNOWN;
}
