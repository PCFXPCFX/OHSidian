/*
 * libvdecprobe.so (round 96e) - in-app AVCodec Configure probe.
 *
 * Loaded by the patched asar main process via process.dlopen(); runs inside
 * the SAME app process whose engine fails with
 * "OH_VideoDecoder_Configure invalid argument", so the HAL behavior we
 * measure is exactly the one the bridge hits. Mirrors the engine by
 * dlopen'ing the NDK libs from /system/lib64 by absolute path, then runs a
 * Configure matrix per mime (width/height only = the engine's shape, plus
 * pixel_format variants) and writes the results to the file named by the
 * OHSIDIAN_PROBE_OUT environment variable (set by the patch to
 * <Documents>/OHSidian/vdec-probe.txt).
 *
 * The only node-facing symbol is napi_register_module_v1 (hand-declared,
 * no NAPI headers needed): it returns the exports object unchanged.
 */

#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

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
typedef bool (*PFN_FormatGetIntValue)(OH_AVFormat *format, const char *key, int32_t *out);
typedef void *(*PFN_GetCapability)(const char *mime, bool isEncoder);
typedef int (*PFN_IsHardware)(void *capability);

static PFN_CreateByMime gCreate;
static PFN_Destroy gDestroy;
static PFN_Configure gConfigure;
static PFN_FormatCreate gFmtCreate;
static PFN_FormatDestroy gFmtDestroy;
static PFN_FormatSetIntValue gSetInt;
static PFN_FormatGetIntValue gGetInt;
static void *gCoreH;
static void *gVdecH;
static const char *gKeyW;
static const char *gKeyH;
static const char *gKeyPf;

static FILE *gOut;

static void *sym(void *h, const char *n)
{
    void *s = dlsym(h, n);
    if (!s) fprintf(gOut, "  [FATAL] dlsym %s failed\n", n);
    return s;
}

static int tryConfigure(const char *mime, int pf, int usePf)
{
    OH_AVCodec *codec = gCreate(mime);
    if (!codec) {
        fprintf(gOut, "  create FAILED\n");
        return -1000;
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
    fprintf(gOut, "==== %s ====\n", mime);
    void *getCap = dlsym(gCoreH, "OH_AVCodec_GetCapability");
    void *isHwSym = dlsym(gCoreH, "OH_AVCapability_IsHardware");
    if (getCap && isHwSym) {
        void *cap = ((PFN_GetCapability)getCap)(mime, false);
        if (cap) {
            int hw = ((PFN_IsHardware)isHwSym)(cap);
            fprintf(gOut, "  capability: hardware=%d\n", hw);
        } else {
            fprintf(gOut, "  capability: none\n");
        }
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
        fprintf(gOut, "  Configure %s -> %d (0=AV_ERR_OK)\n", cases[i].name, r);
    }
}

static void runProbe(void)
{
    const char *outPath = getenv("OHSIDIAN_PROBE_OUT");
    if (!outPath || !outPath[0]) {
        return; /* not requested */
    }
    gOut = fopen(outPath, "w");
    if (!gOut) {
        return;
    }
    fprintf(gOut, "[vdec-probe] dlopen NDK libs by absolute path (mirrors the engine)\n");
    void *core = dlopen("/system/lib64/libnative_media_core.so", RTLD_NOW | RTLD_LOCAL);
    void *vdec = dlopen("/system/lib64/libnative_media_vdec.so", RTLD_NOW | RTLD_LOCAL);
    if (!core || !vdec) {
        fprintf(gOut, "[vdec-probe] FATAL dlopen core=%p vdec=%p\n", core, vdec);
        fclose(gOut);
        return;
    }
    gCreate = (PFN_CreateByMime)sym(gVdecH, "OH_VideoDecoder_CreateByMime");
    gDestroy = (PFN_Destroy)sym(gVdecH, "OH_VideoDecoder_Destroy");
    gConfigure = (PFN_Configure)sym(gVdecH, "OH_VideoDecoder_Configure");
    gFmtCreate = (PFN_FormatCreate)sym(gCoreH, "OH_AVFormat_Create");
    gFmtDestroy = (PFN_FormatDestroy)sym(gCoreH, "OH_AVFormat_Destroy");
    gSetInt = (PFN_FormatSetIntValue)sym(gCoreH, "OH_AVFormat_SetIntValue");
    gGetInt = (PFN_FormatGetIntValue)sym(gCoreH, "OH_AVFormat_GetIntValue");
    gKeyW = (const char *)sym(gCoreH, "OH_MD_KEY_WIDTH");
    gKeyH = (const char *)sym(gCoreH, "OH_MD_KEY_HEIGHT");
    gKeyPf = (const char *)sym(gCoreH, "OH_MD_KEY_PIXEL_FORMAT");
    if (gCreate && gDestroy && gConfigure && gFmtCreate && gSetInt && gKeyW && gKeyH && gKeyPf) {
        fprintf(gOut, "[vdec-probe] keys: width=%s height=%s pixel_format=%s\n", gKeyW, gKeyH, gKeyPf);
        probeMime("video/hevc");
        probeMime("video/avc");
        fprintf(gOut, "[vdec-probe] done\n");
    }
    fclose(gOut);
}

__attribute__((visibility("default")))
void *napi_register_module_v1(void *env, void *exports)
{
    (void)env;
    runProbe();
    return exports;
}
