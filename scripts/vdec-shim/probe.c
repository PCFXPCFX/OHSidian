/*
 * ohprobe (round 96d) - OHOS AVCodec video-decoder Configure probe.
 *
 * Answers, directly on the device, what the closed engine bridge could not
 * tell us: does OH_VideoDecoder_Configure accept width/height-only (what
 * MediaCodecDecoderBridgeImpl passes), and which OH_MD_KEY_PIXEL_FORMAT
 * value makes it accept, for video/hevc and video/avc. Mirrors the engine
 * by dlopen'ing the NDK libs from /system/lib64 by absolute path.
 *
 * Run (developer mode):
 *   hdc file send ohprobe /data/local/tmp/ohprobe
 *   hdc shell chmod +x /data/local/tmp/ohprobe
 *   hdc shell /data/local/tmp/ohprobe
 */

#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

typedef void OH_AVCodec;
typedef void OH_AVFormat;
typedef int OH_AVErrCode;

typedef enum { PF_YUVI420 = 1, PF_NV12 = 2, PF_NV21 = 3, PF_SURFACE = 4, PF_RGBA = 5 } Pf;

typedef OH_AVCodec *(*PFN_CreateByMime)(const char *mime);
typedef OH_AVErrCode (*PFN_Destroy)(OH_AVCodec *codec);
typedef OH_AVErrCode (*PFN_Configure)(OH_AVCodec *codec, OH_AVFormat *format);
typedef OH_AVFormat *(*PFN_FormatCreate)(void);
typedef void (*PFN_FormatDestroy)(OH_AVFormat *format);
typedef bool (*PFN_FormatSetIntValue)(OH_AVFormat *format, const char *key, int32_t value);
typedef bool (*PFN_IsHardware)(void *capability);
typedef void *(*PFN_GetCapability)(const char *mime, bool isEncoder);

static PFN_CreateByMime gCreate;
static PFN_Destroy gDestroy;
static PFN_Configure gConfigure;
static PFN_FormatCreate gFmtCreate;
static PFN_FormatDestroy gFmtDestroy;
static PFN_FormatSetIntValue gSetInt;
static void *gCore = NULL;
static void *gVdec = NULL;

/* OH_MD_KEY_* are exported const char* variables - resolved at runtime. */
static const char *gKeyW;
static const char *gKeyH;
static const char *gKeyPf;

static void *sym(void *h, const char *n)
{
    void *s = dlsym(h, n);
    if (!s) printf("  [FATAL] dlsym %s: %s\n", n, dlerror());
    return s;
}

static int tryConfigure(const char *mime, int pf, int usePf)
{
    OH_AVCodec *codec = gCreate(mime);
    if (!codec) {
        printf("  create FAILED\n");
        return -1;
    }
    OH_AVFormat *fmt = gFmtCreate();
    gSetInt(fmt, gKeyW, 1920);
    gSetInt(fmt, gKeyH, 1080);
    if (usePf) gSetInt(fmt, gKeyPf, pf);
    int r = (int)gConfigure(codec, fmt);
    gFmtDestroy(fmt);
    gDestroy(codec);
    return r;
}

static void probeMime(const char *mime)
{
    printf("==== %s ====\n", mime);
    /* capability: hardware or software */
    void *cap = dlsym(gCore, "OH_AVCodec_GetCapability")
        ? ((PFN_GetCapability)dlsym(gCore, "OH_AVCodec_GetCapability"))(mime, false) : NULL;
    if (cap) {
        PFN_IsHardware isHw = (PFN_IsHardware)dlsym(gCore, "OH_AVCapability_IsHardware");
        if (isHw) printf("  capability: %s decoder available, hardware=%d\n", mime, isHw(cap));
    }
    struct { int pf; const char *name; int usePf; } cases[] = {
        {0, "width/height ONLY (engine bridge shape)", 0},
        {PF_NV12, "+ pixel_format=NV12", 1},
        {PF_SURFACE, "+ pixel_format=SURFACE_FORMAT", 1},
        {PF_YUVI420, "+ pixel_format=YUVI420", 1},
        {PF_RGBA, "+ pixel_format=RGBA", 1},
    };
    for (unsigned i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        int r = tryConfigure(mime, cases[i].pf, cases[i].usePf);
        printf("  Configure %s -> %d (0=AV_ERR_OK)\n", cases[i].name, r);
    }
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    printf("[ohprobe] dlopen NDK libs by absolute path (mirrors the engine)\n");
    gCore = dlopen("/system/lib64/libnative_media_core.so", RTLD_NOW | RTLD_LOCAL);
    gVdec = dlopen("/system/lib64/libnative_media_vdec.so", RTLD_NOW | RTLD_LOCAL);
    if (!gCore || !gVdec) {
        printf("[ohprobe] FATAL dlopen: core=%p vdec=%p (%s)\n", gCore, gVdec, dlerror());
        return 1;
    }
    gCreate = (PFN_CreateByMime)sym(gVdec, "OH_VideoDecoder_CreateByMime");
    gDestroy = (PFN_Destroy)sym(gVdec, "OH_VideoDecoder_Destroy");
    gConfigure = (PFN_Configure)sym(gVdec, "OH_VideoDecoder_Configure");
    gFmtCreate = (PFN_FormatCreate)sym(gCore, "OH_AVFormat_Create");
    gFmtDestroy = (PFN_FormatDestroy)sym(gCore, "OH_AVFormat_Destroy");
    gSetInt = (PFN_FormatSetIntValue)sym(gCore, "OH_AVFormat_SetIntValue");
    gKeyW = (const char *)sym(gCore, "OH_MD_KEY_WIDTH");
    gKeyH = (const char *)sym(gCore, "OH_MD_KEY_HEIGHT");
    gKeyPf = (const char *)sym(gCore, "OH_MD_KEY_PIXEL_FORMAT");
    if (!gCreate || !gDestroy || !gConfigure || !gFmtCreate || !gSetInt || !gKeyW || !gKeyH || !gKeyPf) {
        return 1;
    }
    printf("[ohprobe] keys: width=%s height=%s pixel_format=%s\n", gKeyW, gKeyH, gKeyPf);
    probeMime("video/hevc");
    probeMime("video/avc");
    printf("[ohprobe] done\n");
    return 0;
}
