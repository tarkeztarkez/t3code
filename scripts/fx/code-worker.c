#include "quickjs.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* No quickjs-libc, module loader, environment, filesystem, subprocess, network,
 * or timer bindings enter the guest context. The parent owns the deadline. */
#define MAX_MESSAGE (1024 * 1024)
#define MAX_BOOTSTRAP (16 * 1024)

static int finished;
static clock_t started;

static int interrupt(JSRuntime *runtime, void *opaque) {
    (void)runtime;
    (void)opaque;
    return (double)(clock() - started) / CLOCKS_PER_SEC > 5.0;
}

static JSValue send_message(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self;
    if (argc != 1) return JS_ThrowTypeError(ctx, "Expected one message");
    JSValue json = JS_JSONStringify(ctx, argv[0], JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException(json)) return json;
    size_t length;
    const char *bytes = JS_ToCStringLen(ctx, &length, json);
    JS_FreeValue(ctx, json);
    if (!bytes) return JS_EXCEPTION;
    if (length > MAX_MESSAGE) {
        JS_FreeCString(ctx, bytes);
        return JS_ThrowRangeError(ctx, "Worker output exceeds 1 MiB");
    }
    int failed = fwrite(bytes, 1, length, stdout) != length || fputc('\n', stdout) == EOF || fflush(stdout) != 0;
    JS_FreeCString(ctx, bytes);
    if (failed) return JS_ThrowInternalError(ctx, "Host pipe closed");
    return JS_UNDEFINED;
}

static JSValue finish_message(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    JSValue result = send_message(ctx, self, argc, argv);
    finished = 1;
    return result;
}

static int report_exception(JSContext *ctx) {
    JSValue exception = JS_GetException(ctx);
    const char *message = JS_ToCString(ctx, exception);
    fprintf(stderr, "%s\n", message ? message : "JavaScript execution failed");
    JS_FreeCString(ctx, message);
    JS_FreeValue(ctx, exception);
    return 1;
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fputs("Usage: fx-code-worker TRUSTED_BOOTSTRAP\n", stderr);
        return 1;
    }
    FILE *file = fopen(argv[1], "rb");
    if (!file) return 1;
    char source[MAX_BOOTSTRAP + 32];
    size_t size = fread(source, 1, MAX_BOOTSTRAP, file);
    int failed = ferror(file) || size == MAX_BOOTSTRAP;
    fclose(file);
    if (failed) return 1;
    source[size] = '\0';
    /* The checked-in bootstrap exports one factory. Keep its imports empty. */
    char *declaration = strstr(source, "export function createWorker");
    if (!declaration) return 1;
    memset(declaration, ' ', strlen("export "));
    memcpy(source + size, "\ncreateWorker;", 15);
    size += 14;
    source[size] = '\0';

    JSRuntime *runtime = JS_NewRuntime();
    if (!runtime) return 1;
    JS_SetMemoryLimit(runtime, 32 * 1024 * 1024);
    started = clock();
    JS_SetInterruptHandler(runtime, interrupt, NULL);
    JS_SetMaxStackSize(runtime, 1024 * 1024);
    JSContext *ctx = JS_NewContext(runtime);
    if (!ctx) { JS_FreeRuntime(runtime); return 1; }
    JSValue factory = JS_Eval(ctx, source, size, "bootstrap.js", JS_EVAL_TYPE_GLOBAL);
    int status = 1;
    JSValue dispatch = JS_UNDEFINED;
    char *line = NULL;
    if (JS_IsException(factory)) { report_exception(ctx); goto cleanup; }
    JSValue callbacks[] = {
        JS_NewCFunction(ctx, send_message, "send", 1),
        JS_NewCFunction(ctx, finish_message, "finish", 1),
    };
    dispatch = JS_Call(ctx, factory, JS_UNDEFINED, 2, callbacks);
    JS_FreeValue(ctx, callbacks[0]);
    JS_FreeValue(ctx, callbacks[1]);
    if (JS_IsException(dispatch)) { report_exception(ctx); goto cleanup; }
    line = malloc(MAX_MESSAGE + 2);
    if (!line) goto cleanup;
    fputs("{\"type\":\"ready\"}\n", stdout);
    fflush(stdout);
    while (!finished && fgets(line, MAX_MESSAGE + 2, stdin)) {
        size_t length = strlen(line);
        if (length > MAX_MESSAGE || !length || line[length - 1] != '\n') {
            fputs("Invalid or oversized host message\n", stderr);
            goto cleanup;
        }
        JSValue message = JS_ParseJSON(ctx, line, length, "host.json");
        if (JS_IsException(message)) { report_exception(ctx); goto cleanup; }
        JSValue result = JS_Call(ctx, dispatch, JS_UNDEFINED, 1, &message);
        JS_FreeValue(ctx, message);
        if (JS_IsException(result)) { report_exception(ctx); goto cleanup; }
        JS_FreeValue(ctx, result);
        JSContext *job_context;
        int jobs;
        while ((jobs = JS_ExecutePendingJob(runtime, &job_context)) > 0) {}
        if (jobs < 0) { report_exception(job_context); goto cleanup; }
    }
    status = finished ? 0 : 1;

cleanup:
    free(line);
    JS_FreeValue(ctx, dispatch);
    JS_FreeValue(ctx, factory);
    JS_FreeContext(ctx);
    JS_FreeRuntime(runtime);
    return status;
}
