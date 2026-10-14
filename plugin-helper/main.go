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

var endpoint = "http://127.0.0.1:12945"
var version = "dev"

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
	transport := client
	if route == "/api/request" {
		transport = &http.Client{Timeout: 65 * time.Second}
	}
	response, err := transport.Do(request)
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

func beaconReady() error {
	response, err := client.Get(endpoint + "/status")
	if err != nil {
		return errors.New("Open ASIP Beacon and sign in.")
	}
	defer response.Body.Close()
	var state struct {
		SignedIn bool `json:"signedIn"`
	}
	if response.StatusCode != 200 || json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&state) != nil {
		return errors.New("ASIP Beacon is unavailable.")
	}
	if !state.SignedIn {
		return errors.New("Sign in to ASIP Beacon first.")
	}
	return nil
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
	if len(output) > 16000 {
		output = output[:16000]
	}
	return strings.TrimSpace(string(output))
}

func outcome(input map[string]any) (string, string) {
	if message := stringValue(input["error"]); message != "" {
		return "failed", message
	}
	for _, key := range []string{"tool_response", "toolResult", "result"} {
		if result, ok := input[key].(map[string]any); ok {
			if failed, ok := result["isError"].(bool); ok && failed {
				return "failed", "Tool reported a failure"
			}
			for _, field := range []string{"exit_code", "exitCode", "returncode"} {
				if code, ok := result[field].(float64); ok {
					if code != 0 {
						return "failed", fmt.Sprintf("Tool exited with code %.0f", code)
					}
					return "tool_succeeded", "Tool exited with code 0"
				}
			}
		}
	}
	return "", ""
}
func project(cwd string) string {
	identity, _ := resolveProject(cwd)
	return identity
}

func resolveProject(cwd string) (string, map[string]any) {
	evidence := map[string]any{"workingDirectory": cwd, "method": "unresolved"}
	if cwd == "" {
		return "", evidence
	}
	root := git(cwd, "rev-parse", "--show-toplevel")
	if root == "" {
		evidence["method"] = "working-directory"
		return cwd, evidence
	}
	evidence["repositoryRoot"] = root
	evidence["method"] = "git-root"
	remote := git(root, "remote", "get-url", "origin")
	if remote == "" {
		return root, evidence
	}
	if canonical := repository(remote); canonical != "" {
		evidence["method"] = "git-origin"
		evidence["repository"] = canonical
		return canonical, evidence
	}
	return root, evidence
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

func asipTool(name string) bool {
	for _, tool := range []string{"asip_recall", "asip_record", "asip_status", "asip_connect", "asip_projects", "asip_connections", "asip_api_request"} {
		if strings.HasSuffix(name, tool) {
			return true
		}
	}
	return false
}

func hook(event string) (context map[string]any) {
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
	if arguments, ok := input["tool_input"].(map[string]any); ok {
		if directory := stringValue(arguments["workdir"]); directory != "" {
			cwd = directory
		}
	}
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
	if asipTool(tool) {
		data["asip_tool"] = true
	}
	for _, key := range []string{"tool_use_id", "turn_id", "agent_id", "stepIdx", "model", "modelName", "transcript_path", "transcriptPath", "workspacePaths"} {
		if value, exists := input[key]; exists {
			data[key] = value
		}
	}
	for _, key := range []string{"prompt", "tool_input", "tool_response", "toolCall", "toolResult", "result", "error", "last_assistant_message", "assistantMessage"} {
		if asipTool(tool) && (key == "tool_response" || key == "toolResult" || key == "result") {
			continue
		}
		if value, exists := input[key]; exists {
			data[key] = trace(value, 0)
		}
	}
	if cwd != "" {
		data["head"] = git(cwd, "rev-parse", "HEAD")
		data["worktree"] = git(cwd, "status", "--porcelain=v1", "--untracked-files=all")
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
	if observed, message := outcome(input); observed != "" {
		kind = observed
		summary = strings.TrimSpace(tool + " " + message)
	}
	encoded, _ := json.Marshal(data)
	if len(encoded) > 60000 {
		for _, key := range []string{"tool_input", "tool_response", "toolCall", "toolResult", "result"} {
			delete(data, key)
		}
		data["trace_truncated"] = true
	}
	identity, association := resolveProject(cwd)
	data["project_evidence"] = association
	_, err = call("/events", map[string]any{"session": session, "kind": kind, "project": identity, "summary": summary, "data": data}, credential)
	if err == nil && (event == "SessionStart" || event == "UserPromptSubmit") {
		value, _ := json.Marshal(map[string]any{"session": session, "project": identity})
		message := "Use this native context for ASIP records: " + string(value)
		if agent == "antigravity" {
			return map[string]any{"injectSteps": []any{map[string]any{"systemMessage": map[string]string{"systemMessage": message}}}}
		}
		return map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": event, "additionalContext": message}}
	}
	return nil
}

func tools() []map[string]any {
	empty := map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}
	// Keep the catalog stable: native clients may cache it across sign-in.
	// Every memory operation still requires a connected account in Beacon.
	return []map[string]any{{"name": "asip_projects", "description": "List projects found in recorded agent work.", "inputSchema": empty},
		{"name": "asip_connections", "description": "List named API connections available through ASIP.", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"project": map[string]string{"type": "string"}}}},
		{"name": "asip_api_request", "description": "Call a named API connection. ASIP supplies its credential and records the HTTP result.", "inputSchema": map[string]any{"type": "object", "required": []string{"name", "path"}, "properties": map[string]any{"name": map[string]string{"type": "string"}, "path": map[string]string{"type": "string"}, "method": map[string]any{"type": "string", "enum": []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"}}, "body": map[string]any{}, "project": map[string]string{"type": "string"}, "session": map[string]string{"type": "string"}}}},
		{"name": "asip_connect", "description": "Connect this plugin to your ASIP account in Beacon.", "inputSchema": empty}, {"name": "asip_status", "description": "ASIP account and Beacon connection.", "inputSchema": empty},
		{"name": "asip_recall", "description": "Find previous project work and results. Connect ASIP first.", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"project": map[string]string{"type": "string"}, "query": map[string]string{"type": "string"}}}},
		{"name": "asip_record", "description": "Save the intended work, result, or supporting evidence for this project. Codex supplies the native session automatically; other clients must provide their session ID. Connect ASIP first.", "inputSchema": map[string]any{"type": "object", "required": []string{"kind", "summary"}, "properties": map[string]any{"session": map[string]string{"type": "string"}, "kind": map[string]string{"type": "string"}, "summary": map[string]string{"type": "string"}, "project": map[string]string{"type": "string"}, "data": map[string]string{"type": "object"}}}}}
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
			result = map[string]any{"protocolVersion": protocol, "capabilities": map[string]any{"tools": map[string]bool{"listChanged": true}, "logging": map[string]any{}}, "serverInfo": map[string]string{"name": "asip", "version": version}}
		case "ping":
			result = map[string]any{}
		case "logging/setLevel":
			result = map[string]any{}
		case "tools/list":
			result = map[string]any{"tools": tools()}
		case "tools/call":
			name := stringValue(params["name"])
			args, _ := params["arguments"].(map[string]any)
			meta, _ := params["_meta"].(map[string]any)
			nativeSession := stringValue(meta["sessionId"])
			nativeThread := stringValue(meta["threadId"])
			contextSession := nativeThread
			if contextSession == "" {
				contextSession = nativeSession
			}
			if name == "asip_record" || name == "asip_api_request" {
				if args == nil {
					args = map[string]any{}
				}
				if contextSession != "" {
					args["session"] = contextSession
					evidence, _ := args["data"].(map[string]any)
					if evidence == nil {
						evidence = map[string]any{}
					}
					evidence["native_session"] = map[string]string{"sessionId": nativeSession, "threadId": nativeThread, "callId": stringValue(meta["callId"])}
					args["data"] = evidence
				}
			}
			var data map[string]any
			var err error
			switch name {
			case "asip_connect":
				if data, err = call("/plugin/status", map[string]any{"session": contextSession}, token()); err == nil {
					break
				}
				if err = beaconReady(); err != nil {
					break
				}
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
				data = map[string]any{"state": "connecting", "message": "Click Connect in ASIP Beacon."}
			case "asip_status":
				data, err = call("/plugin/status", map[string]any{"session": contextSession}, token())
			case "asip_recall":
				data, err = call("/recall", args, token())
			case "asip_connections":
				data, err = call("/connections", args, token())
			case "asip_projects":
				data, err = call("/projects", args, token())
			case "asip_api_request":
				data, err = call("/api/request", args, token())
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
		context := hook(event)
		if context != nil {
			raw, _ := json.Marshal(context)
			fmt.Println(string(raw))
		} else if agent == "antigravity" && event == "PreToolUse" {
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
