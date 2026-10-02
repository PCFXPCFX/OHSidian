/*
 * libnative_media_vdec.so shim v7 (round 98) - OHSidian HEVC compat layer.
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
 * Round 97/98 compat layer: a SURFACE RELAY. SetSurface is intercepted; the
 * codec gets a private NV12 consumer queue (OH_ConsumerSurface_Create), and
 * the frame-available callback converts each decoded frame NV12->RGBA into
 * the bridge's original RGBA window. The bridge's frame factory then imports
 * a correctly-filled RGBA buffer - the exact configuration that rendered
 * (garbage) in round 96g, now with correct content.
 *
 * Round 98: the conversion runs ON THE GPU. Device-proven in 97d: the
 * codec's hardware video buffers cannot be CPU-mapped (OH_NativeBuffer_Map
 * and MapPlanes both fail even with CPU usage bits requested), so the
 * fixed-point CPU converter never executed. But the GPU CAN sample those
 * same buffers (96g rendered their NV12 content through the engine's own
 * RGBA EGLImage import). So the relay imports the NV12 buffer as an
 * EGLImage (EGL_NATIVE_BUFFER_OHOS), binds it to a GL_TEXTURE_EXTERNAL_OES
 * sampler - the driver converts YUV->RGB from the buffer's own color
 * metadata during sampling - and renders a fullscreen quad through an FBO
 * into the bridge's RGBA buffer, imported as a 2D-texture EGLImage.
 * glFinish before FlushBuffer guarantees the consumer reads completed
 * pixels. eglCreateImage is resolved at runtime (KHR suffix first, EGL 1.5
 * core name second) because the NDK stub only exports the core name.
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
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>

#ifndef EGL_NATIVE_BUFFER_OHOS
#define EGL_NATIVE_BUFFER_OHOS 0x34E1
#endif
#ifndef GL_TEXTURE_EXTERNAL_OES
#define GL_TEXTURE_EXTERNAL_OES 0x8D65
#endif
#ifndef EGL_OPENGL_ES3_BIT
#define EGL_OPENGL_ES3_BIT 0x0040
#endif

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

/* ===== GPU conversion (round 98). The codec's NV12 output buffers cannot
   be CPU-mapped (97d device-proven), but the GPU can sample them (96g). So
   the relay converts on the GPU: NV12 buffer -> EGLImage -> EXTERNAL_OES
   sample (driver does YUV->RGB from the buffer's color metadata) -> FBO
   render into the bridge's RGBA buffer. All GL/EGL objects are created
   lazily on the frame-available thread; if the frame thread dies with one
   consumer and a new one appears, the context is rebuilt on the new
   thread. ===== */
typedef EGLImageKHR (*PFN_eglCreateImageAny)(EGLDisplay dpy, EGLContext ctx,
    EGLenum target, EGLClientBuffer buffer, const EGLint *attribs);
typedef EGLBoolean (*PFN_eglDestroyImageAny)(EGLDisplay dpy, EGLImageKHR image);
static PFN_eglCreateImageAny gEglCreateImage;
static PFN_eglDestroyImageAny gEglDestroyImage;

static EGLDisplay gEglDpy = EGL_NO_DISPLAY;
static EGLContext gEglCtx = EGL_NO_CONTEXT;
static EGLSurface gEglPbuf = EGL_NO_SURFACE;
static GLuint gProg = 0;
static GLuint gSrcTex = 0;
static GLuint gDstTex = 0;
static GLuint gFbo = 0;
static GLint gAPos = -1;
static GLint gScaleLoc = -1;
static int gEglReady = 0;
static int gIsES3 = 0;
static int gGpuDead = 0;

/* ===== GLES entry points via eglGetProcAddress (round 98c). Direct
   linkage to libGLESv2.so is INERT on this stack: eglCreateContext and
   eglMakeCurrent succeed, but every directly-linked gl* call no-ops
   (glCreateShader -> 0 with err 0x0; device log 02:38) - the front
   library is not wired to the loaded vendor driver for our client.
   EGL_KHR_get_all_proc_addresses IS advertised (device dump), so resolve
   the whole set through EGL, exactly like the engine does. ===== */
typedef GLuint (*PFN_glCreateShader)(GLenum type);
typedef void (*PFN_glShaderSource)(GLuint shader, GLsizei count,
    const GLchar *const *string, const GLint *length);
typedef void (*PFN_glCompileShader)(GLuint shader);
typedef void (*PFN_glGetShaderiv)(GLuint shader, GLenum pname, GLint *params);
typedef void (*PFN_glGetShaderInfoLog)(GLuint shader, GLsizei bufSize,
    GLsizei *length, GLchar *infoLog);
typedef void (*PFN_glDeleteShader)(GLuint shader);
typedef GLenum (*PFN_glGetError)(void);
typedef GLuint (*PFN_glCreateProgram)(void);
typedef void (*PFN_glAttachShader)(GLuint program, GLuint shader);
typedef void (*PFN_glLinkProgram)(GLuint program);
typedef void (*PFN_glGetProgramiv)(GLuint program, GLenum pname, GLint *params);
typedef void (*PFN_glGetProgramInfoLog)(GLuint program, GLsizei bufSize,
    GLsizei *length, GLchar *infoLog);
typedef void (*PFN_glDeleteProgram)(GLuint program);
typedef GLint (*PFN_glGetAttribLocation)(GLuint program, const GLchar *name);
typedef GLint (*PFN_glGetUniformLocation)(GLuint program, const GLchar *name);
typedef void (*PFN_glGenTextures)(GLsizei n, GLuint *textures);
typedef void (*PFN_glBindTexture)(GLenum target, GLuint texture);
typedef void (*PFN_glTexParameteri)(GLenum target, GLenum pname, GLint param);
typedef void (*PFN_glEGLImageTargetTexture2DOES)(GLenum target,
    GLeglImageOES image);
typedef void (*PFN_glGenFramebuffers)(GLsizei n, GLuint *framebuffers);
typedef void (*PFN_glBindFramebuffer)(GLenum target, GLuint framebuffer);
typedef void (*PFN_glFramebufferTexture2D)(GLenum target, GLenum attachment,
    GLenum textarget, GLuint texture, GLint level);
typedef GLenum (*PFN_glCheckFramebufferStatus)(GLenum target);
typedef void (*PFN_glViewport)(GLint x, GLint y, GLsizei w, GLsizei h);
typedef void (*PFN_glUseProgram)(GLuint program);
typedef void (*PFN_glUniform2f)(GLint location, GLfloat x, GLfloat y);
typedef void (*PFN_glVertexAttribPointer)(GLuint index, GLint size,
    GLenum type, GLboolean normalized, GLsizei stride, const void *pointer);
typedef void (*PFN_glEnableVertexAttribArray)(GLuint index);
typedef void (*PFN_glDrawArrays)(GLenum mode, GLint first, GLsizei count);
typedef void (*PFN_glFinish)(void);
typedef const GLubyte *(*PFN_glGetString)(GLenum name);

static PFN_glCreateShader pglCreateShader;
static PFN_glShaderSource pglShaderSource;
static PFN_glCompileShader pglCompileShader;
static PFN_glGetShaderiv pglGetShaderiv;
static PFN_glGetShaderInfoLog pglGetShaderInfoLog;
static PFN_glDeleteShader pglDeleteShader;
static PFN_glGetError pglGetError;
static PFN_glCreateProgram pglCreateProgram;
static PFN_glAttachShader pglAttachShader;
static PFN_glLinkProgram pglLinkProgram;
static PFN_glGetProgramiv pglGetProgramiv;
static PFN_glGetProgramInfoLog pglGetProgramInfoLog;
static PFN_glDeleteProgram pglDeleteProgram;
static PFN_glGetAttribLocation pglGetAttribLocation;
static PFN_glGetUniformLocation pglGetUniformLocation;
static PFN_glGenTextures pglGenTextures;
static PFN_glBindTexture pglBindTexture;
static PFN_glTexParameteri pglTexParameteri;
static PFN_glEGLImageTargetTexture2DOES pglEGLImageTargetTexture2DOES;
static PFN_glGenFramebuffers pglGenFramebuffers;
static PFN_glBindFramebuffer pglBindFramebuffer;
static PFN_glFramebufferTexture2D pglFramebufferTexture2D;
static PFN_glCheckFramebufferStatus pglCheckFramebufferStatus;
static PFN_glViewport pglViewport;
static PFN_glUseProgram pglUseProgram;
static PFN_glUniform2f pglUniform2f;
static PFN_glVertexAttribPointer pglVertexAttribPointer;
static PFN_glEnableVertexAttribArray pglEnableVertexAttribArray;
static PFN_glDrawArrays pglDrawArrays;
static PFN_glFinish pglFinish;
static PFN_glGetString pglGetString;

#define GLPROC(var, name) \
    do { \
        (var) = (typeof(var))(void *)eglGetProcAddress(name); \
        if ((var) == NULL) { \
            SHIM_LOGE("gpu: eglGetProcAddress(%{public}s) -> NULL", name); \
            return 0; \
        } \
    } while (0)

static int gpuResolveProcs(void)
{
    static int done = 0;
    if (done) {
        return 1;
    }
    GLPROC(pglCreateShader, "glCreateShader");
    GLPROC(pglShaderSource, "glShaderSource");
    GLPROC(pglCompileShader, "glCompileShader");
    GLPROC(pglGetShaderiv, "glGetShaderiv");
    GLPROC(pglGetShaderInfoLog, "glGetShaderInfoLog");
    GLPROC(pglDeleteShader, "glDeleteShader");
    GLPROC(pglGetError, "glGetError");
    GLPROC(pglCreateProgram, "glCreateProgram");
    GLPROC(pglAttachShader, "glAttachShader");
    GLPROC(pglLinkProgram, "glLinkProgram");
    GLPROC(pglGetProgramiv, "glGetProgramiv");
    GLPROC(pglGetProgramInfoLog, "glGetProgramInfoLog");
    GLPROC(pglDeleteProgram, "glDeleteProgram");
    GLPROC(pglGetAttribLocation, "glGetAttribLocation");
    GLPROC(pglGetUniformLocation, "glGetUniformLocation");
    GLPROC(pglGenTextures, "glGenTextures");
    GLPROC(pglBindTexture, "glBindTexture");
    GLPROC(pglTexParameteri, "glTexParameteri");
    GLPROC(pglEGLImageTargetTexture2DOES, "glEGLImageTargetTexture2DOES");
    GLPROC(pglGenFramebuffers, "glGenFramebuffers");
    GLPROC(pglBindFramebuffer, "glBindFramebuffer");
    GLPROC(pglFramebufferTexture2D, "glFramebufferTexture2D");
    GLPROC(pglCheckFramebufferStatus, "glCheckFramebufferStatus");
    GLPROC(pglViewport, "glViewport");
    GLPROC(pglUseProgram, "glUseProgram");
    GLPROC(pglUniform2f, "glUniform2f");
    GLPROC(pglVertexAttribPointer, "glVertexAttribPointer");
    GLPROC(pglEnableVertexAttribArray, "glEnableVertexAttribArray");
    GLPROC(pglDrawArrays, "glDrawArrays");
    GLPROC(pglFinish, "glFinish");
    GLPROC(pglGetString, "glGetString");
    done = 1;
    SHIM_LOGI("gpu: %d GLES entry points resolved via eglGetProcAddress", 31);
    return 1;
}

static pthread_t gEglOwner;
static int gEglOwnerValid = 0;

/* ESSL 1.00 pair: needs GL_OES_EGL_image_external + samplerExternalOES. */
static const char *G_VSH_ES2 =
    "attribute vec2 aPos;\n"
    "uniform vec2 uScale;\n"
    "varying vec2 vUV;\n"
    "void main() {\n"
    /* Y is flipped: FBO row 0 (first bytes, which the bridge samples as
       GL texel (0,0) = bottom) must hold the video's BOTTOM row, i.e. the
       END of the NV12 buffer. uScale trims codec padding when the output
       description reports stride/slice height larger than the picture. */
    "  vUV = vec2((aPos.x * 0.5 + 0.5) * uScale.x, (0.5 - aPos.y * 0.5) * uScale.y);\n"
    "  gl_Position = vec4(aPos, 0.0, 1.0);\n"
    "}\n";

/* The driver converts YUV->RGB during the external-OES sample (BT.709 per
   the buffer's own metadata: matrix_coefficients=1 in the device dump), so
   the shader is a passthrough. */
static const char *G_FSH_ES2 =
    "#extension GL_OES_EGL_image_external : require\n"
    "precision mediump float;\n"
    "varying vec2 vUV;\n"
    "uniform samplerExternalOES sTex;\n"
    "void main() {\n"
    "  gl_FragColor = vec4(texture2D(sTex, vUV).rgb, 1.0);\n"
    "}\n";

/* ESSL 3.00 pair: same extension under its _essl3 spelling; tried when the
   driver rejects the ESSL1 form (device log 02:29: "gpu: program link
   failed" on the ES2 path). */
static const char *G_VSH_ES3 =
    "#version 300 es\n"
    "in vec2 aPos;\n"
    "uniform vec2 uScale;\n"
    "out vec2 vUV;\n"
    "void main() {\n"
    "  vUV = vec2((aPos.x * 0.5 + 0.5) * uScale.x, (0.5 - aPos.y * 0.5) * uScale.y);\n"
    "  gl_Position = vec4(aPos, 0.0, 1.0);\n"
    "}\n";

static const char *G_FSH_ES3 =
    "#version 300 es\n"
    "#extension GL_OES_EGL_image_external_essl3 : require\n"
    "precision mediump float;\n"
    "in vec2 vUV;\n"
    "uniform samplerExternalOES sTex;\n"
    "out vec4 oClr;\n"
    "void main() {\n"
    "  oClr = vec4(texture(sTex, vUV).rgb, 1.0);\n"
    "}\n";

/* hilog lines cap out around 4KB; print driver logs in ~600B chunks. */
static void gpuLogText(const char *what, const char *s)
{
    if (s == NULL || s[0] == '\0') {
        SHIM_LOGE("gpu: %s (no log)", what);
        return;
    }
    size_t len = strlen(s);
    size_t off = 0;
    int chunk = 0;
    while (off < len && chunk < 8) {
        char buf[600];
        size_t n = len - off;
        if (n > sizeof(buf) - 1) {
            n = sizeof(buf) - 1;
        }
        memcpy(buf, s + off, n);
        buf[n] = '\0';
        SHIM_LOGE("gpu: %s[%{public}d]: %{public}s", what, chunk++, buf);
        off += n;
    }
}

static GLuint gpuCompile(GLenum type, const char *src)
{
    GLuint sh = pglCreateShader(type);
    if (sh == 0) {
        SHIM_LOGE("gpu: pglCreateShader(%{public}u) -> 0 (err 0x%{public}x)",
            (unsigned)type, (unsigned)pglGetError());
        return 0;
    }
    pglShaderSource(sh, 1, &src, NULL);
    pglCompileShader(sh);
    GLint ok = 0;
    pglGetShaderiv(sh, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[1024];
        GLsizei n = 0;
        log[0] = '\0';
        pglGetShaderInfoLog(sh, (GLsizei)sizeof(log) - 1, &n, log);
        if (n < 0 || n >= (GLsizei)sizeof(log)) {
            n = (GLsizei)sizeof(log) - 1;
        }
        log[n] = '\0';
        gpuLogText(type == GL_VERTEX_SHADER ? "VS compile" : "FS compile", log);
        pglDeleteShader(sh);
        return 0;
    }
    return sh;
}

static GLuint gpuBuildProgram(int es3)
{
    const char *vsh = es3 ? G_VSH_ES3 : G_VSH_ES2;
    const char *fsh = es3 ? G_FSH_ES3 : G_FSH_ES2;
    GLuint vs = gpuCompile(GL_VERTEX_SHADER, vsh);
    GLuint fs = gpuCompile(GL_FRAGMENT_SHADER, fsh);
    if (vs == 0 || fs == 0) {
        if (vs != 0) pglDeleteShader(vs);
        if (fs != 0) pglDeleteShader(fs);
        return 0;
    }
    GLuint prog = pglCreateProgram();
    if (prog == 0) {
        pglDeleteShader(vs);
        pglDeleteShader(fs);
        return 0;
    }
    pglAttachShader(prog, vs);
    pglAttachShader(prog, fs);
    pglLinkProgram(prog);
    pglDeleteShader(vs);
    pglDeleteShader(fs);
    GLint ok = 0;
    pglGetProgramiv(prog, GL_LINK_STATUS, &ok);
    if (!ok) {
        char log[1024];
        GLsizei n = 0;
        log[0] = '\0';
        pglGetProgramInfoLog(prog, (GLsizei)sizeof(log) - 1, &n, log);
        if (n < 0 || n >= (GLsizei)sizeof(log)) {
            n = (GLsizei)sizeof(log) - 1;
        }
        log[n] = '\0';
        gpuLogText("program link", log);
        pglDeleteProgram(prog);
        return 0;
    }
    return prog;
}

static int gpuSetup(EGLConfig cfg, int es3)
{
    const EGLint cfgAttr[] = {
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
        EGL_RENDERABLE_TYPE, es3 ? EGL_OPENGL_ES3_BIT : EGL_OPENGL_ES2_BIT,
        EGL_NONE
    };
    EGLConfig use = NULL;
    EGLint n = 0;
    if (!eglChooseConfig(gEglDpy, cfgAttr, &use, 1, &n) || n < 1) {
        SHIM_LOGE("gpu: eglChooseConfig(ES%{public}d) failed", es3 ? 3 : 2);
        return 0;
    }
    const EGLint ctxAttr[] = { EGL_CONTEXT_CLIENT_VERSION, es3 ? 3 : 2, EGL_NONE };
    gEglCtx = eglCreateContext(gEglDpy, use, EGL_NO_CONTEXT, ctxAttr);
    if (gEglCtx == EGL_NO_CONTEXT) {
        SHIM_LOGE("gpu: eglCreateContext(ES%{public}d) failed", es3 ? 3 : 2);
        return 0;
    }
    const EGLint pbAttr[] = { EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE };
    gEglPbuf = eglCreatePbufferSurface(gEglDpy, use, pbAttr);
    if (gEglPbuf == EGL_NO_SURFACE ||
        !eglMakeCurrent(gEglDpy, gEglPbuf, gEglPbuf, gEglCtx)) {
        SHIM_LOGE("gpu: pbuffer/makeCurrent(ES%{public}d) failed", es3 ? 3 : 2);
        return 0;
    }
    static int gGlExtLogged = 0;
    if (!gGlExtLogged) {
        gGlExtLogged = 1;
        const GLubyte *glext = pglGetString(GL_EXTENSIONS);
        gpuLogText("GL_EXTENSIONS", glext != NULL ? (const char *)glext : "(null)");
    }
    gProg = gpuBuildProgram(es3);
    if (gProg == 0) {
        SHIM_LOGE("gpu: program build failed (ES%{public}d)", es3 ? 3 : 2);
        return 0;
    }
    gAPos = pglGetAttribLocation(gProg, "aPos");
    gScaleLoc = pglGetUniformLocation(gProg, "uScale");
    pglGenTextures(1, &gSrcTex);
    pglGenTextures(1, &gDstTex);
    pglGenFramebuffers(1, &gFbo);
    gIsES3 = es3;
    return 1;
}

static int gpuInit(void)
{
    if (gGpuDead) {
        return 0;
    }
    if (gEglReady && gEglOwnerValid && pthread_equal(gEglOwner, pthread_self())) {
        return 1;
    }
    if (gEglReady) {
        /* the previous frame thread died with its consumer; its context and
           GL objects die with it - rebuild everything on this thread */
        SHIM_LOGI("gpu: frame thread changed - rebuilding EGL context");
        if (gEglDpy != EGL_NO_DISPLAY) {
            if (gEglPbuf != EGL_NO_SURFACE) {
                eglDestroySurface(gEglDpy, gEglPbuf);
            }
            if (gEglCtx != EGL_NO_CONTEXT) {
                eglDestroyContext(gEglDpy, gEglCtx);
            }
        }
        gEglPbuf = EGL_NO_SURFACE;
        gEglCtx = EGL_NO_CONTEXT;
        gProg = 0;
        gSrcTex = 0;
        gDstTex = 0;
        gFbo = 0;
        gEglReady = 0;
        gEglOwnerValid = 0;
    }
    if (gEglDpy == EGL_NO_DISPLAY) {
        gEglDpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
        if (gEglDpy == EGL_NO_DISPLAY || !eglInitialize(gEglDpy, NULL, NULL)) {
            SHIM_LOGE("gpu: eglGetDisplay/Initialize failed");
            gEglDpy = EGL_NO_DISPLAY;
            return 0;
        }
        static int gEglExtLogged = 0;
        if (!gEglExtLogged) {
            gEglExtLogged = 1;
            const char *eglext = eglQueryString(gEglDpy, EGL_EXTENSIONS);
            gpuLogText("EGL_EXTENSIONS", eglext != NULL ? eglext : "(null)");
        }
        if (!gpuResolveProcs()) {
            gGpuDead = 1;
            return 0;
        }
    }
    if (gEglCreateImage == NULL) {
        /* the NDK stub exports only the EGL 1.5 core name; the runtime
           driver is usually EGL 1.4 with the KHR extension - try both */
        gEglCreateImage = (PFN_eglCreateImageAny)(void *)eglGetProcAddress("eglCreateImageKHR");
        if (gEglCreateImage == NULL) {
            gEglCreateImage = (PFN_eglCreateImageAny)(void *)eglGetProcAddress("eglCreateImage");
        }
        gEglDestroyImage = (PFN_eglDestroyImageAny)(void *)eglGetProcAddress("eglDestroyImageKHR");
        if (gEglDestroyImage == NULL) {
            gEglDestroyImage = (PFN_eglDestroyImageAny)(void *)eglGetProcAddress("eglDestroyImage");
        }
        if (gEglCreateImage == NULL || gEglDestroyImage == NULL) {
            SHIM_LOGE("gpu: no eglCreateImage/eglDestroyImage entry points");
            return 0;
        }
    }
    if (gpuSetup(NULL, 0)) {
        gEglOwner = pthread_self();
        gEglOwnerValid = 1;
        gEglReady = 1;
        SHIM_LOGI("gpu: EGL+GLES ES%{public}d ready on frame thread (program %u)",
            gIsES3 ? 3 : 2, gProg);
        return 1;
    }
    /* retry as ESSL 3.00: some drivers expose the external-image extension
       only under its _essl3 name or inside ES3 contexts */
    eglMakeCurrent(gEglDpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (gEglPbuf != EGL_NO_SURFACE) {
        eglDestroySurface(gEglDpy, gEglPbuf);
        gEglPbuf = EGL_NO_SURFACE;
    }
    if (gEglCtx != EGL_NO_CONTEXT) {
        eglDestroyContext(gEglDpy, gEglCtx);
        gEglCtx = EGL_NO_CONTEXT;
    }
    gProg = 0;
    gSrcTex = 0;
    gDstTex = 0;
    gFbo = 0;
    if (gpuSetup(NULL, 1)) {
        gEglOwner = pthread_self();
        gEglOwnerValid = 1;
        gEglReady = 1;
        SHIM_LOGI("gpu: EGL+GLES ES%{public}d ready on frame thread (program %u)",
            gIsES3 ? 3 : 2, gProg);
        return 1;
    }
    gGpuDead = 1;
    SHIM_LOGE("gpu: no usable GLES context+program (ES2/ES3 both failed) - relay idle");
    return 0;
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

/* Query the codec's reported stride / slice height from
   GetOutputDescription. Used to trim codec padding when the EGLImage view
   of the buffer is larger than the picture (this device reports
   stride==width, slice==height, so the trim is a no-op here - kept for
   devices that pad). */
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
    waitFence(srcFence);

    if (!gGeomSet && gRelayW > 0 && gRelayH > 0) {
        gHandleOpt(gOrigWin, SET_BUFFER_GEOMETRY, gRelayW, gRelayH);
        gGeomSet = 1;
    }
    if (!gpuInit()) {
        gImageRelBuf(gConsumer, srcWinBuf, srcFence);
        return;
    }

    OHNativeWindowBuffer *dstWinBuf = NULL;
    int dstFence = -1;
    if (gReqBuffer == NULL ||
        gReqBuffer(gOrigWin, &dstWinBuf, &dstFence) != 0 || dstWinBuf == NULL) {
        gImageRelBuf(gConsumer, srcWinBuf, srcFence);
        return;
    }
    waitFence(dstFence);
    close(dstFence);

    /* GPU convert: import both WINDOW buffers as EGLImages, sample the
       NV12 one through EXTERNAL_OES, render into the RGBA one through an
       FBO. EGL_NATIVE_BUFFER_OHOS takes the OHNativeWindowBuffer ITSELF
       (the driver dereferences it via GetBufferHandleFromNative; passing
       the derived OH_NativeBuffer instead crashes there - device crash
       02:45, this is the same pattern OHOS's own NativeImage uses). The
       bridge queue's format/usage is the bridge's own (96g proved its RGBA
       buffers allocate and import fine) - only the geometry is set once. */
    EGLImageKHR srcImg = gEglCreateImage(gEglDpy, EGL_NO_CONTEXT,
        EGL_NATIVE_BUFFER_OHOS, (EGLClientBuffer)srcWinBuf, NULL);
    EGLImageKHR dstImg = gEglCreateImage(gEglDpy, EGL_NO_CONTEXT,
        EGL_NATIVE_BUFFER_OHOS, (EGLClientBuffer)dstWinBuf, NULL);
    if (srcImg == EGL_NO_IMAGE_KHR || dstImg == EGL_NO_IMAGE_KHR) {
        SHIM_LOGE("gpu: eglCreateImage failed src=%{public}d dst=%{public}d",
            srcImg != EGL_NO_IMAGE_KHR, dstImg != EGL_NO_IMAGE_KHR);
        if (srcImg != EGL_NO_IMAGE_KHR) {
            gEglDestroyImage(gEglDpy, srcImg);
        }
        if (dstImg != EGL_NO_IMAGE_KHR) {
            gEglDestroyImage(gEglDpy, dstImg);
        }
        gImageRelBuf(gConsumer, srcWinBuf, srcFence);
        return;
    }
    pglUseProgram(gProg);
    float scaleX = 1.0f;
    float scaleY = 1.0f;
    int stride = queryFmtInt("stride", 0);
    int sliceH = queryFmtInt("video_slice_height", 0);
    if (stride > gRelayW && gRelayW > 0) {
        scaleX = (float)gRelayW / (float)stride;
    }
    if (sliceH > gRelayH && gRelayH > 0) {
        scaleY = (float)gRelayH / (float)sliceH;
    }
    pglUniform2f(gScaleLoc, scaleX, scaleY);
    pglBindTexture(GL_TEXTURE_EXTERNAL_OES, gSrcTex);
    pglTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    pglTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    pglTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    pglTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    pglEGLImageTargetTexture2DOES(GL_TEXTURE_EXTERNAL_OES, (GLeglImageOES)srcImg);
    pglBindTexture(GL_TEXTURE_2D, gDstTex);
    pglTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    pglTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    pglTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    pglTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    pglEGLImageTargetTexture2DOES(GL_TEXTURE_2D, (GLeglImageOES)dstImg);
    pglBindFramebuffer(GL_FRAMEBUFFER, gFbo);
    pglFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
        gDstTex, 0);
    if (pglCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
        SHIM_LOGE("gpu: FBO incomplete");
        pglBindFramebuffer(GL_FRAMEBUFFER, 0);
        gEglDestroyImage(gEglDpy, srcImg);
        gEglDestroyImage(gEglDpy, dstImg);
        gImageRelBuf(gConsumer, srcWinBuf, srcFence);
        return;
    }
    pglViewport(0, 0, gRelayW, gRelayH);
    {
        static const float quad[8] = {
            -1.0f, -1.0f, 1.0f, -1.0f, -1.0f, 1.0f, 1.0f, 1.0f
        };
        pglVertexAttribPointer(gAPos, 2, GL_FLOAT, GL_FALSE, 0, quad);
        pglEnableVertexAttribArray(gAPos);
        pglDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    }
    pglFinish();
    pglBindFramebuffer(GL_FRAMEBUFFER, 0);
    gEglDestroyImage(gEglDpy, srcImg);
    gEglDestroyImage(gEglDpy, dstImg);

    Region region;
    region.rects = NULL;
    region.rectNumber = 0;
    gFlushBuffer(gOrigWin, dstWinBuf, -1, region);
    gImageRelBuf(gConsumer, srcWinBuf, srcFence);
    gRelayFrames++;
    if ((gRelayFrames % 60) == 1) {
        SHIM_LOGI("relayed %{public}ld frames (%{public}dx%{public}d, gpu yuv->rgba, scale %.3f/%.3f)",
            gRelayFrames, gRelayW, gRelayH, scaleX, scaleY);
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
    SHIM_LOGI("shim v7d loaded - gpu surface-relay compat layer (round 98)");
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
