package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const endpoint = "http://127.0.0.1:12945"

var agent string
var client = &http.Client{Timeout: 10 * time.Second}

func home() string {
	if root := os.Getenv("ASIP_PLUGIN_STATE"); root != "" {
		return root
	}
	root, _ := os.UserConfigDir()
	return filepath.Join(root, "ASIP", "plugins")
}
func tokenPath() string { return filepath.Join(home(), agent+".json") }
func token() string {
	raw, err := os.ReadFile(tokenPath())
	if err != nil {
		return ""
	}
	var state map[string]string
	json.Unmarshal(raw, &state)
	return state["token"]
}
func call(route string, body any, credential string) (map[string]any, error) {
	data, _ := json.Marshal(body)
	request, err := http.NewRequest("POST", endpoint+route, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if credential != "" {
		request.Header.Set("Authorization", "Bearer "+credential)
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("Open ASIP Beacon and sign in.")
	}
	defer response.Body.Close()
	var result map[string]any
	if err = json.NewDecoder(io.LimitReader(response.Body, 1024*1024)).Decode(&result); err != nil {
		return nil, err
	}
	if response.StatusCode != 200 {
		message, _ := result["error"].(string)
		return nil, errors.New(message)
	}
	return result, nil
}

func signin() (map[string]any, error) {
	verifier := make([]byte, 32)
	if _, err := rand.Read(verifier); err != nil {
		return nil, err
	}
	proof := hex.EncodeToString(verifier)
	challenge := sha256.Sum256([]byte(proof))
	request, err := call("/plugin/signin", map[string]string{"agent": agent, "challenge": hex.EncodeToString(challenge[:])}, "")
	if err != nil {
		return nil, err
	}
	id, _ := request["requestId"].(string)
	for until := time.Now().Add(5 * time.Minute); time.Now().Before(until); time.Sleep(time.Second) {
		result, err := call("/plugin/poll", map[string]string{"requestId": id, "verifier": proof}, "")
		if err != nil {
			return nil, err
		}
		if result["state"] == "connected" {
			value, _ := result["token"].(string)
			if value == "" {
				return nil, errors.New("ASIP did not finish sign-in.")
			}
			if err = os.MkdirAll(home(), 0700); err != nil {
				return nil, err
			}
			raw, _ := json.Marshal(map[string]string{"token": value})
			file, err := os.CreateTemp(home(), ".signin-")
			if err != nil {
				return nil, err
			}
			name := file.Name()
			defer os.Remove(name)
			if err = file.Chmod(0600); err != nil {
				file.Close()
				return nil, err
			}
			if _, err = file.Write(raw); err != nil {
				file.Close()
				return nil, err
			}
			if err = file.Sync(); err != nil {
				file.Close()
				return nil, err
			}
			if err = file.Close(); err != nil {
				return nil, err
			}
			if err = os.Rename(name, tokenPath()); err != nil {
				return nil, err
			}
			return map[string]any{"connected": true, "agent": agent}, nil
		}
	}
	return nil, errors.New("Sign-in expired. Try again.")
}

func digest(value any) string {
	raw, _ := json.Marshal(value)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func stringValue(value any) string { text, _ := value.(string); return text }
func git(cwd string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	arguments := append([]string{"-c", "core.fsmonitor=false", "-C", cwd}, args...)
	cmd := exec.CommandContext(ctx, "git", arguments...)
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}
func project(cwd string) string {
	if cwd == "" {
		return ""
	}
	root := git(cwd, "rev-parse", "--show-toplevel")
	if root == "" {
		return cwd
	}
	remote := git(root, "remote", "get-url", "origin")
	if remote == "" {
		return root
	}
	if canonical := repository(remote); canonical != "" {
		return canonical
	}
	return root
}

func repository(remote string) string {
	if !strings.Contains(remote, "://") && strings.Contains(remote, "@") {
		if split := strings.Index(remote, ":"); split > 0 {
			remote = "ssh://" + remote[:split] + "/" + remote[split+1:]
		}
	}
	parsed, err := url.Parse(remote)
	if err != nil || parsed.Hostname() == "" || parsed.Path == "" {
		return ""
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" && parsed.Scheme != "ssh" && parsed.Scheme != "git" {
		return ""
	}
	// User info, query parameters, and transport do not belong to repository identity.
	repo := strings.TrimSuffix(strings.Trim(parsed.Path, "/"), ".git")
	if repo == "" {
		return ""
	}
	return strings.ToLower(parsed.Hostname()) + "/" + repo
}

func trace(value any, depth int) any {
	if depth > 12 {
		return "[nested value]"
	}
	switch typed := value.(type) {
	case string:
		if len(typed) > 16000 {
			return typed[:16000] + "…"
		}
		return typed
	case map[string]any:
		result := map[string]any{}
		for key, item := range typed {
			lower := strings.ToLower(key)
			if lower == "authorization" || lower == "api_key" || lower == "apikey" || lower == "password" || lower == "access_token" || lower == "refresh_token" || lower == "client_secret" {
				result[key] = "[credential]"
			} else {
				result[key] = trace(item, depth+1)
			}
		}
		return result
	case []any:
		result := []any{}
		for index, item := range typed {
			if index >= 100 {
				break
			}
			result = append(result, trace(item, depth+1))
		}
		return result
	default:
		return value
	}
}

func hook(event string) {
	credential := token()
	if credential == "" {
		return
	}
	client.Timeout = 2 * time.Second
	if _, err := call("/plugin/status", map[string]any{}, credential); err != nil {
		return
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 {
		return
	}
	var input map[string]any
	if json.Unmarshal(raw, &input) != nil {
		return
	}
	session := stringValue(input["session_id"])
	if session == "" {
		session = stringValue(input["conversationId"])
	}
	if session == "" {
		return
	}
	cwd := stringValue(input["cwd"])
	if cwd == "" {
		if paths, ok := input["workspacePaths"].([]any); ok && len(paths) == 1 {
			cwd = stringValue(paths[0])
		}
	}
	tool := stringValue(input["tool_name"])
	if call, ok := input["toolCall"].(map[string]any); ok {
		tool = stringValue(call["name"])
		if args, ok := call["args"].(map[string]any); ok && stringValue(args["Cwd"]) != "" {
			cwd = stringValue(args["Cwd"])
		}
	}
	data := map[string]any{"tool": tool, "trace_sha256": digest(input), "cwd": cwd}
	for _, key := range []string{"tool_use_id", "turn_id", "agent_id", "stepIdx", "model", "modelName", "transcript_path", "transcriptPath"} {
		if value, exists := input[key]; exists {
			data[key] = value
		}
	}
	for _, key := range []string{"prompt", "tool_input", "tool_response", "toolCall", "toolResult", "result", "error", "last_assistant_message", "assistantMessage"} {
		if value, exists := input[key]; exists {
			data[key] = trace(value, 0)
		}
	}
	if cwd != "" {
		data["head"] = git(cwd, "rev-parse", "HEAD")
		data["worktree"] = git(cwd, "status", "--porcelain=v1", "--untracked-files=no")
	}
	kind := event
	summary := strings.TrimSpace(event + " " + tool)
	if prompt := stringValue(input["prompt"]); prompt != "" {
		kind = "intent"
		summary = prompt
	}
	if message := stringValue(input["last_assistant_message"]); message != "" {
		summary = message
	}
	if message := stringValue(input["error"]); message != "" {
		kind = "failed"
		summary = message
	}
	encoded, _ := json.Marshal(data)
	if len(encoded) > 60000 {
		for _, key := range []string{"tool_input", "tool_response", "toolCall", "toolResult", "result"} {
			delete(data, key)
		}
		data["trace_truncated"] = true
	}
	_, _ = call("/events", map[string]any{"session": session, "kind": kind, "project": project(cwd), "summary": summary, "data": data}, credential)
}

func tools() []map[string]any {
	empty := map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}
	result := []map[string]any{{"name": "asip_connect", "description": "Sign in to the ASIP plugin through Beacon.", "inputSchema": empty}, {"name": "asip_status", "description": "ASIP account and Beacon connection.", "inputSchema": empty}}
	if _, err := call("/plugin/status", map[string]any{}, token()); err == nil {
		result = append(result, map[string]any{"name": "asip_recall", "description": "Find previous project work and results.", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"project": map[string]string{"type": "string"}, "query": map[string]string{"type": "string"}}}},
			map[string]any{"name": "asip_record", "description": "Save the intended work, result, or supporting evidence for this project.", "inputSchema": map[string]any{"type": "object", "required": []string{"session", "kind", "summary"}, "properties": map[string]any{"session": map[string]string{"type": "string"}, "kind": map[string]string{"type": "string"}, "summary": map[string]string{"type": "string"}, "project": map[string]string{"type": "string"}, "data": map[string]string{"type": "object"}}}})
	}
	return result
}

func mcp() {
	reader := bufio.NewScanner(os.Stdin)
	reader.Buffer(make([]byte, 65536), 1024*1024)
	writer := bufio.NewWriter(os.Stdout)
	var writes sync.Mutex
	var connecting atomic.Bool
	send := func(value any) {
		writes.Lock()
		defer writes.Unlock()
		raw, _ := json.Marshal(value)
		fmt.Fprintln(writer, string(raw))
		writer.Flush()
	}
	for reader.Scan() {
		var message map[string]any
		if json.Unmarshal(reader.Bytes(), &message) != nil {
			send(map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "Invalid JSON"}})
			continue
		}
		id, present := message["id"]
		if !present {
			continue
		}
		method := stringValue(message["method"])
		params, _ := message["params"].(map[string]any)
		var result any
		switch method {
		case "initialize":
			protocol := stringValue(params["protocolVersion"])
			if protocol != "2025-11-25" && protocol != "2025-06-18" && protocol != "2025-03-26" && protocol != "2024-11-05" {
				protocol = "2025-11-25"
			}
			result = map[string]any{"protocolVersion": protocol, "capabilities": map[string]any{"tools": map[string]bool{"listChanged": true}, "logging": map[string]any{}}, "serverInfo": map[string]string{"name": "asip", "version": "0.1.0"}}
		case "ping":
			result = map[string]any{}
		case "tools/list":
			result = map[string]any{"tools": tools()}
		case "tools/call":
			name := stringValue(params["name"])
			args, _ := params["arguments"].(map[string]any)
			var data map[string]any
			var err error
			switch name {
			case "asip_connect":
				if connecting.CompareAndSwap(false, true) {
					go func() {
						defer connecting.Store(false)
						_, failure := signin()
						if failure != nil {
							send(map[string]any{"jsonrpc": "2.0", "method": "notifications/message", "params": map[string]any{"level": "error", "logger": "asip", "data": failure.Error()}})
						} else {
							send(map[string]any{"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
						}
					}()
				}
				data = map[string]any{"state": "signing-in", "message": "Finish sign-in in ASIP Beacon."}
			case "asip_status":
				data, err = call("/plugin/status", map[string]any{}, token())
			case "asip_recall":
				data, err = call("/recall", args, token())
			case "asip_record":
				data, err = call("/events", args, token())
			default:
				err = errors.New("Unknown ASIP tool.")
			}
			text := ""
			if err != nil {
				text = err.Error()
			} else {
				raw, _ := json.Marshal(data)
				text = string(raw)
			}
			result = map[string]any{"content": []map[string]string{{"type": "text", "text": text}}, "isError": err != nil}
			send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
			continue
		default:
			send(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32601, "message": "Unknown method"}})
			continue
		}
		send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	}
}

func main() {
	mode := ""
	event := ""
	args := os.Args[1:]
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "--agent":
			index++
			if index < len(args) {
				agent = args[index]
			}
		case "--event":
			index++
			if index < len(args) {
				event = args[index]
			}
		default:
			if mode == "" {
				mode = args[index]
			}
		}
	}
	if agent != "codex" && agent != "claude-code" && agent != "antigravity" {
		fmt.Fprintln(os.Stderr, "Choose an ASIP agent plugin.")
		os.Exit(1)
	}
	switch mode {
	case "mcp":
		mcp()
	case "hook":
		hook(event)
		if agent == "antigravity" && event == "PreToolUse" {
			fmt.Println(`{"decision":"allow"}`)
		} else if agent == "antigravity" && event == "Stop" {
			fmt.Println(`{"decision":"stop"}`)
		} else {
			fmt.Println(`{}`)
		}
	case "connect":
		_, err := signin()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("ASIP connected.")
	default:
		fmt.Fprintln(os.Stderr, "ASIP plugin: mcp, hook, or connect")
		os.Exit(1)
	}
}
