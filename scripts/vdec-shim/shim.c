/*
 * libnative_media_vdec.so shim (round 96c) - OHSidian HEVC experiment.
 *
 * WHY: libelectron.so's closed-source MediaCodecDecoderBridgeImpl configures
 * the OHOS video decoder with width/height ONLY (no OH_MD_KEY_PIXEL_FORMAT),
 * and device HALs reject that with "invalid argument"; the bridge then does
 * not report the failure to Chromium, leaving <video> hung (hilog:
 * OH_VideoDecoder_Configure invalid argument). See CHANGES rounds 95b/95c.
 *
 * HOW: this library is built with the SAME soname as the system
 * libnative_media_vdec.so and bundled into the HAP, so the dynamic linker
 * loads THIS copy for the app process (shadowing). Everything is forwarded
 * 1:1 to the real system library (dlopen by absolute path), except
 * OH_VideoDecoder_Configure, which (a) dumps the incoming format keys into
 * hilog and (b) when OH_MD_KEY_PIXEL_FORMAT is absent, sets NV12 and
 * retries - the missing key is the leading suspect for the HAL rejection.
 *
 * SAFETY: with the routing feature flag off (round 95c default) the bridge
 * is never invoked and this shim is inert; delete this file to remove it.
 *
 * Build (DevEco NDK):
 *   clang.exe --target=aarch64-linux-ohos --sysroot=<NDK>/sysroot \
 *     -shared -fPIC -O2 shim.c -o libnative_media_vdec.so \
 *     -lhilog_ndk.z.so -lnative_media_core
 */

#include <dlfcn.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <hilog/log.h>
#include <multimedia/player_framework/native_avcodec_base.h>
#include <multimedia/player_framework/native_avcodec_videodecoder.h>
#include <multimedia/player_framework/native_avformat.h>
#include <native_buffer/native_buffer.h>
#include <native_window/external_window.h>

#undef LOG_DOMAIN
#undef LOG_TAG
#define LOG_DOMAIN 0x0000
#define LOG_TAG "VdecShim"

#define SHIM_LOGI(...) ((void)OH_LOG_Print(LOG_APP, LOG_INFO, LOG_DOMAIN, LOG_TAG, __VA_ARGS__))
#define SHIM_LOGE(...) ((void)OH_LOG_Print(LOG_APP, LOG_ERROR, LOG_DOMAIN, LOG_TAG, __VA_ARGS__))

/* The real system library, loaded by absolute path so our own soname never
 * self-resolves. */
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

/* Loaded lazily on first use: the shim's constructor runs during library
 * loading, before libelectron's own NDK bootstrap - keep it minimal. */
static void *gCore = NULL;
static bool gCoreTried = false;
/* Round 96i: the consumer surface's buffer queue must ALLOCATE NV12 to
   match the HAL's hard-wired NV12 output (OnOutputFormatChanged always
   reports pixel_format=2 / graphic 24; RGBA output is 'unsupport
   interface'). Set the window format at SetSurface time - before Start,
   i.e. before any buffer is dequeued - via the standard video-surface
   mechanism. */
typedef int32_t (*PFN_WindowOpt)(OHNativeWindow *window, int code, ...);
static void *gNwLib = NULL;
static PFN_WindowOpt gWindowOpt;

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

/* Format-key dump + fix helper. OH_AVFormat exposes no key enumeration, so
 * probe the keys the HAL cares about for a surface-mode video decoder. */
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
        /* Round 96h order: RGBA first. Round 96g device evidence: with
           SURFACE_FORMAT the frames FINALLY reached the screen (noise =
           render path alive, format interpretation wrong) - the bridge's
           surface queue does render, it just disagrees with the buffer
           layout. Vendor surfaces default to RGBA8888 allocation while
           the HAL kept writing YUV; an explicit RGBA key makes the HAL
           convert in hardware so buffer content and allocation match.
           SURFACE_FORMAT then NV12 remain as Configure fallbacks (the
           dict re-evaluates per failed call, device-verified). */
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
    SHIM_LOGI("shim loaded - shadowing system libnative_media_vdec.so (round 96c HEVC experiment)");
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
    gNwLib = dlopen("/system/lib64/libnative_window.so", RTLD_NOW | RTLD_LOCAL);
    if (gNwLib != NULL) {
        gWindowOpt = (PFN_WindowOpt)dlsym(gNwLib, "OH_NativeWindow_NativeWindowHandleOpt");
        if (gWindowOpt == NULL) {
            SHIM_LOGE("NativeWindowHandleOpt dlsym failed: %{public}s", dlerror());
        }
    } else {
        SHIM_LOGE("libnative_window.so dlopen failed: %{public}s", dlerror());
    }
    SHIM_LOGI("real symbols resolved: configure=%{public}d getfmt=%{public}d",
        gConfigure != NULL, gGetIntValue != NULL);
}

/* ===== Exported forwards (surface the engine imports) ===== */

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
    if (gWindowOpt != NULL && window != NULL) {
        /* NATIVEBUFFER_PIXEL_FMT_YCBCR_420_SP == 24 (matches the HAL's
           video_graphic_pixel_format=24 in OnOutputFormatChanged). The
           bridge never sets a queue format, so the queue defaults to
           RGBA8888 and every NV12 frame renders as noise (round 96g). */
        int32_t r = gWindowOpt(window, SET_FORMAT,
            (int32_t)NATIVEBUFFER_PIXEL_FMT_YCBCR_420_SP);
        SHIM_LOGI("SetSurface: queue SET_FORMAT NV12(24) -> %{public}d", r);
    }
    OH_AVErrCode r2 = gSetSurface ? gSetSurface(codec, window) : AV_ERR_UNKNOWN;
    SHIM_LOGI("SetSurface -> %{public}d", r2);
    return r2;
}

OH_AVErrCode OH_VideoDecoder_Configure(OH_AVCodec *codec, OH_AVFormat *format)
{
    dumpAndFix(format);
    OH_AVErrCode r = gConfigure ? gConfigure(codec, format) : AV_ERR_UNKNOWN;
    if (r != AV_ERR_OK && gSetIntValue != NULL) {
        /* Fallback order (96h): RGBA failed -> SURFACE_FORMAT (96g:
           rendered, wrong layout) -> NV12 (96f: configured OK at 1080p). */
        SHIM_LOGI("Configure with RGBA failed (%{public}d) - retrying with SURFACE_FORMAT", r);
        gSetIntValue(format, OH_MD_KEY_PIXEL_FORMAT, AV_PIXEL_FORMAT_SURFACE_FORMAT);
        OH_AVErrCode r2 = gConfigure ? gConfigure(codec, format) : AV_ERR_UNKNOWN;
        SHIM_LOGI("Configure(SURFACE_FORMAT) -> %{public}d", r2);
        if (r2 != AV_ERR_OK) {
            SHIM_LOGI("retrying with NV12");
            gSetIntValue(format, OH_MD_KEY_PIXEL_FORMAT, AV_PIXEL_FORMAT_NV12);
            r2 = gConfigure ? gConfigure(codec, format) : AV_ERR_UNKNOWN;
            SHIM_LOGI("Configure(NV12) -> %{public}d", r2);
        }
        if (r2 == AV_ERR_OK) {
            return AV_ERR_OK;
        }
    }
    SHIM_LOGI("Configure -> %{public}d", r);
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
