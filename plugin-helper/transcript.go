package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Antigravity's Stop input identifies the transcript but omits the response.
// Read only its bounded tail, and never carry an earlier answer past a new
// user message or a later model invocation that has not produced an answer.
func antigravityFinalMessage(input map[string]any, session string) (string, map[string]any) {
	if input["fullyIdle"] != true || strings.TrimSpace(stringValue(input["error"])) != "" {
		return "", nil
	}
	file := stringValue(input["transcriptPath"])
	if strings.HasPrefix(file, "~/") {
		root, err := os.UserHomeDir()
		if err != nil {
			return "", nil
		}
		file = filepath.Join(root, file[2:])
	}
	file = filepath.Clean(file)
	name := filepath.Base(file)
	if !filepath.IsAbs(file) || session == "" || session == "." || session == ".." || filepath.Base(session) != session || (name != "transcript.jsonl" && name != "transcript_full.jsonl") {
		return "", nil
	}
	ending := filepath.Join("brain", session, ".system_generated", "logs", name)
	if !strings.HasSuffix(file, string(filepath.Separator)+ending) {
		return "", nil
	}
	info, err := os.Stat(file)
	if err != nil || !info.Mode().IsRegular() {
		return "", nil
	}
	stream, err := os.Open(file)
	if err != nil {
		return "", nil
	}
	defer stream.Close()
	info, err = stream.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", nil
	}
	const limit = int64(4 * 1024 * 1024)
	offset := max(int64(0), info.Size()-limit)
	if _, err := stream.Seek(offset, io.SeekStart); err != nil {
		return "", nil
	}
	scanner := bufio.NewScanner(io.LimitReader(stream, limit))
	scanner.Buffer(make([]byte, 64*1024), int(limit))
	if offset > 0 {
		// The first tail fragment may begin in the middle of a JSON record.
		scanner.Scan()
	}
	var message string
	var evidence map[string]any
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var row map[string]any
		if json.Unmarshal(line, &row) != nil {
			message, evidence = "", nil
			continue
		}
		if row["type"] == "USER_INPUT" || row["status"] == "ERROR" {
			message, evidence = "", nil
			continue
		}
		if row["source"] != "MODEL" || row["type"] != "PLANNER_RESPONSE" {
			continue
		}
		message, evidence = "", nil
		calls, _ := row["tool_calls"].([]any)
		content := stringValue(row["content"])
		if row["status"] != "DONE" || len(calls) > 0 || strings.TrimSpace(content) == "" {
			continue
		}
		checksum := sha256.Sum256(line)
		message = content
		evidence = map[string]any{
			"method":        "antigravity-transcript",
			"path":          file,
			"record_sha256": hex.EncodeToString(checksum[:]),
		}
		for _, key := range []string{"step_index", "created_at"} {
			if value, ok := row[key]; ok {
				evidence[key] = value
			}
		}
	}
	if scanner.Err() != nil {
		return "", nil
	}
	return message, evidence
}
