package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef struct {
    void* ptr;
    size_t len;
} cliproxy_buffer;

typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);

typedef struct {
    uint32_t abi_version;
    void* host_ctx;
    cliproxy_host_call_fn call;
    cliproxy_host_free_fn free_buffer;
} cliproxy_host_api;

typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);

typedef struct {
    uint32_t abi_version;
    cliproxy_plugin_call_fn call;
    cliproxy_plugin_free_fn free_buffer;
    cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;

extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);
*/
import "C"

import (
    "bufio"
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "strings"
    "time"
    "unsafe"

    "github.com/router-for-me/CLIProxyAPI/v7/sdk/pluginabi"
    "github.com/router-for-me/CLIProxyAPI/v7/sdk/pluginapi"
)

const (
    providerID = "opencode-go-muse"
    modelID    = "muse-spark-1.3-contributor"
    authType   = "opencode-go-muse"

    upstreamResponses = "https://opencode.ai/zen/go/v1/responses"
)

type envelope struct {
    OK     bool            `json:"ok"`
    Result json.RawMessage `json:"result,omitempty"`
    Error  *envelopeError  `json:"error,omitempty"`
}

type envelopeError struct {
    Code    string `json:"code"`
    Message string `json:"message"`
}

type identifierResponse struct {
    Identifier string `json:"identifier"`
}

type registration struct {
    SchemaVersion uint32                  `json:"schema_version"`
    Metadata      pluginapi.Metadata      `json:"metadata"`
    Capabilities  registrationCapability `json:"capabilities"`
}

type registrationCapability struct {
    ModelProvider         bool                         `json:"model_provider"`
    AuthProvider          bool                         `json:"auth_provider"`
    Executor              bool                         `json:"executor"`
    ExecutorModelScope    pluginapi.ExecutorModelScope `json:"executor_model_scope"`
    ExecutorInputFormats  []string                     `json:"executor_input_formats,omitempty"`
    ExecutorOutputFormats []string                     `json:"executor_output_formats,omitempty"`
}

type storedAuth struct {
    Type   string `json:"type"`
    APIKey string `json:"api_key"`
}

type executorStreamRequest struct {
    pluginapi.ExecutorRequest
    StreamID       string `json:"stream_id,omitempty"`
    HostCallbackID string `json:"host_callback_id,omitempty"`
}

type streamResponse struct {
    Headers http.Header                     `json:"headers,omitempty"`
    Chunks  []pluginapi.ExecutorStreamChunk `json:"chunks,omitempty"`
}

var httpClient = &http.Client{
    Timeout: 10 * time.Minute,
    Transport: &http.Transport{
        MaxIdleConns:        20,
        MaxIdleConnsPerHost: 10,
        IdleConnTimeout:     90 * time.Second,
    },
}

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
    if plugin == nil {
        return 1
    }
    plugin.abi_version = C.uint32_t(pluginabi.ABIVersion)
    plugin.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
    plugin.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
    plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
    return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, requestLen C.size_t, response *C.cliproxy_buffer) C.int {
    if response != nil {
        response.ptr = nil
        response.len = 0
    }
    if method == nil {
        writeResponse(response, errorEnvelope("invalid_method", "method is required"))
        return 1
    }

    var raw []byte
    if request != nil && requestLen > 0 {
        raw = C.GoBytes(unsafe.Pointer(request), C.int(requestLen))
    }

    out, err := handleMethod(C.GoString(method), raw)
    if err != nil {
        writeResponse(response, errorEnvelope("plugin_error", err.Error()))
        return 1
    }
    writeResponse(response, out)
    return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, _ C.size_t) {
    if ptr != nil {
        C.free(ptr)
    }
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {}

func handleMethod(method string, request []byte) ([]byte, error) {
    switch method {
    case pluginabi.MethodPluginRegister, pluginabi.MethodPluginReconfigure:
        return okEnvelope(pluginRegistration())

    case pluginabi.MethodModelStatic, pluginabi.MethodModelForAuth:
        return okEnvelope(pluginapi.ModelResponse{Provider: providerID, Models: models()})

    case pluginabi.MethodAuthIdentifier:
        return okEnvelope(identifierResponse{Identifier: providerID})
    case pluginabi.MethodAuthParse:
        return handleAuthParse(request)
    case pluginabi.MethodAuthRefresh:
        return handleAuthRefresh(request)

    case pluginabi.MethodExecutorIdentifier:
        return okEnvelope(identifierResponse{Identifier: providerID})
    case pluginabi.MethodExecutorExecute:
        return handleExecute(request)
    case pluginabi.MethodExecutorExecuteStream:
        return handleExecuteStream(request)

    default:
        return errorEnvelope("unknown_method", "unknown method: "+method), nil
    }
}

func pluginRegistration() registration {
    return registration{
        SchemaVersion: pluginabi.SchemaVersion,
        Metadata: pluginapi.Metadata{
            Name:    "Muse Spark 1.3 / OpenCode Go",
            Version: "0.1.0",
            Author:  "heihei0299",
        },
        Capabilities: registrationCapability{
            ModelProvider:         true,
            AuthProvider:          true,
            Executor:              true,
            ExecutorModelScope:    pluginapi.ExecutorModelScopeBoth,
            ExecutorInputFormats:  []string{"responses"},
            ExecutorOutputFormats: []string{"responses"},
        },
    }
}

func models() []pluginapi.ModelInfo {
    return []pluginapi.ModelInfo{{
        ID:                         modelID,
        Object:                     "model",
        OwnedBy:                    providerID,
        Name:                       modelID,
        DisplayName:                "Muse Spark 1.3 Contributor",
        SupportedGenerationMethods: []string{"responses"},
        UserDefined:                true,
    }}
}

func parseStoredAuth(raw []byte) (*storedAuth, error) {
    if len(raw) == 0 {
        return nil, fmt.Errorf("empty auth storage")
    }
    var a storedAuth
    if err := json.Unmarshal(raw, &a); err != nil {
        return nil, err
    }
    if a.Type != authType || strings.TrimSpace(a.APIKey) == "" {
        return nil, fmt.Errorf("not a %s credential", authType)
    }
    return &a, nil
}

func authData(a *storedAuth) pluginapi.AuthData {
    storage, _ := json.Marshal(a)
    return pluginapi.AuthData{
        Provider:    providerID,
        ID:          providerID,
        FileName:    "opencode-go-muse.json",
        Label:       "OpenCode Go / Muse Spark 1.3",
        StorageJSON: storage,
        Metadata:    map[string]any{"type": authType},
    }
}

func handleAuthParse(raw []byte) ([]byte, error) {
    var req pluginapi.AuthParseRequest
    if err := json.Unmarshal(raw, &req); err != nil {
        return nil, err
    }
    a, err := parseStoredAuth(req.RawJSON)
    if err != nil {
        return okEnvelope(pluginapi.AuthParseResponse{Handled: false})
    }
    return okEnvelope(pluginapi.AuthParseResponse{Handled: true, Auth: authData(a)})
}

func handleAuthRefresh(raw []byte) ([]byte, error) {
    var req pluginapi.AuthRefreshRequest
    if err := json.Unmarshal(raw, &req); err != nil {
        return nil, err
    }
    a, err := parseStoredAuth(req.StorageJSON)
    if err != nil {
        return nil, err
    }
    return okEnvelope(pluginapi.AuthRefreshResponse{Auth: authData(a)})
}

func preparePayload(payload, original []byte, stream bool) ([]byte, error) {
    body := payload
    if len(body) == 0 {
        body = original
    }
    if len(body) == 0 {
        return nil, fmt.Errorf("empty request payload")
    }

    var obj map[string]any
    if err := json.Unmarshal(body, &obj); err != nil {
        return nil, fmt.Errorf("invalid Responses payload: %w", err)
    }
    obj["model"] = modelID
    obj["stream"] = stream
    return json.Marshal(obj)
}

func newUpstreamRequest(body []byte, apiKey string) (*http.Request, error) {
    req, err := http.NewRequest(http.MethodPost, upstreamResponses, bytes.NewReader(body))
    if err != nil {
        return nil, err
    }
    req.Header.Set("Authorization", "Bearer "+apiKey)
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Accept", "application/json, text/event-stream")
    req.Header.Set("User-Agent", "cpa-plugin-muse-spark/0.1.0")
    return req, nil
}

func handleExecute(raw []byte) ([]byte, error) {
    var req pluginapi.ExecutorRequest
    if err := json.Unmarshal(raw, &req); err != nil {
        return nil, err
    }
    if req.Model != "" && req.Model != modelID {
        return nil, fmt.Errorf("unsupported model %q", req.Model)
    }

    a, err := parseStoredAuth(req.StorageJSON)
    if err != nil {
        return nil, err
    }
    body, err := preparePayload(req.Payload, req.OriginalRequest, false)
    if err != nil {
        return nil, err
    }
    upstreamReq, err := newUpstreamRequest(body, a.APIKey)
    if err != nil {
        return nil, err
    }

    resp, err := httpClient.Do(upstreamReq)
    if err != nil {
        return nil, fmt.Errorf("opencode go request failed: %w", err)
    }
    defer resp.Body.Close()

    responseBody, err := io.ReadAll(resp.Body)
    if err != nil {
        return nil, err
    }
    if resp.StatusCode >= 400 {
        return nil, fmt.Errorf("opencode go HTTP %d: %s", resp.StatusCode, truncate(responseBody, 1200))
    }

    return okEnvelope(pluginapi.ExecutorResponse{Payload: responseBody, Headers: cloneResponseHeaders(resp.Header)})
}

func handleExecuteStream(raw []byte) ([]byte, error) {
    var req executorStreamRequest
    if err := json.Unmarshal(raw, &req); err != nil {
        return nil, err
    }
    if req.Model != "" && req.Model != modelID {
        return nil, fmt.Errorf("unsupported model %q", req.Model)
    }

    a, err := parseStoredAuth(req.StorageJSON)
    if err != nil {
        return nil, err
    }
    body, err := preparePayload(req.Payload, req.OriginalRequest, true)
    if err != nil {
        return nil, err
    }
    upstreamReq, err := newUpstreamRequest(body, a.APIKey)
    if err != nil {
        return nil, err
    }

    resp, err := httpClient.Do(upstreamReq)
    if err != nil {
        return nil, fmt.Errorf("opencode go stream failed: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode >= 400 {
        responseBody, _ := io.ReadAll(resp.Body)
        return nil, fmt.Errorf("opencode go HTTP %d: %s", resp.StatusCode, truncate(responseBody, 1200))
    }

    chunks, err := readSSEFrames(resp.Body)
    if err != nil {
        return nil, err
    }
    return okEnvelope(streamResponse{
        Headers: http.Header{
            "Content-Type":  []string{"text/event-stream"},
            "Cache-Control": []string{"no-cache"},
        },
        Chunks: chunks,
    })
}

func readSSEFrames(r io.Reader) ([]pluginapi.ExecutorStreamChunk, error) {
    scanner := bufio.NewScanner(r)
    scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)

    var chunks []pluginapi.ExecutorStreamChunk
    var frame bytes.Buffer
    flush := func() {
        if frame.Len() == 0 {
            return
        }
        payload := append([]byte(nil), frame.Bytes()...)
        chunks = append(chunks, pluginapi.ExecutorStreamChunk{Payload: payload})
        frame.Reset()
    }

    for scanner.Scan() {
        line := scanner.Text()
        if line == "" {
            flush()
            continue
        }
        frame.WriteString(line)
        frame.WriteByte('\n')
    }
    flush()

    if err := scanner.Err(); err != nil {
        return nil, fmt.Errorf("read upstream SSE: %w", err)
    }
    return chunks, nil
}

func cloneResponseHeaders(src http.Header) http.Header {
    dst := http.Header{}
    for _, k := range []string{"Content-Type", "Request-Id", "X-Request-Id"} {
        if values := src.Values(k); len(values) > 0 {
            dst[k] = append([]string(nil), values...)
        }
    }
    return dst
}

func truncate(b []byte, n int) string {
    s := strings.TrimSpace(string(b))
    if len(s) <= n {
        return s
    }
    return s[:n] + "..."
}

func okEnvelope(v any) ([]byte, error) {
    result, err := json.Marshal(v)
    if err != nil {
        return nil, err
    }
    return json.Marshal(envelope{OK: true, Result: result})
}

func errorEnvelope(code, message string) []byte {
    raw, _ := json.Marshal(envelope{OK: false, Error: &envelopeError{Code: code, Message: message}})
    return raw
}

func writeResponse(response *C.cliproxy_buffer, raw []byte) {
    if response == nil || len(raw) == 0 {
        return
    }
    ptr := C.CBytes(raw)
    response.ptr = ptr
    response.len = C.size_t(len(raw))
}
