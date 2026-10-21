package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const finalTranscriptRow = `{"step_index":38,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-10-20T12:00:00Z","content":"Verified the build. Café 日本語.","thinking":"Private reasoning must not become the summary."}`

func transcriptFixture(t *testing.T, content string) (map[string]any, string) {
	t.Helper()
	file := filepath.Join(t.TempDir(), "agent", "brain", "native-session", ".system_generated", "logs", "transcript_full.jsonl")
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return map[string]any{"transcriptPath": file, "fullyIdle": true, "error": ""}, file
}

func TestAntigravityTranscriptFinalResponse(t *testing.T) {
	for _, name := range []string{"transcript_full.jsonl", "transcript.jsonl"} {
		t.Run(name, func(t *testing.T) {
			input, file := transcriptFixture(t, finalTranscriptRow+"\n")
			if name != filepath.Base(file) {
				renamed := filepath.Join(filepath.Dir(file), name)
				if err := os.Rename(file, renamed); err != nil {
					t.Fatal(err)
				}
				file = renamed
				input["transcriptPath"] = file
			}
			message, source := antigravityFinalMessage(input, "native-session")
			if message != "Verified the build. Café 日本語." {
				t.Fatalf("response: %q", message)
			}
			checksum := sha256.Sum256([]byte(finalTranscriptRow))
			if source["record_sha256"] != hex.EncodeToString(checksum[:]) || source["path"] != file || source["step_index"] != float64(38) || source["created_at"] != "2026-10-20T12:00:00Z" {
				t.Fatalf("missing source evidence: %v", source)
			}
			if len(source) != 5 {
				t.Fatalf("unexpected transcript fields retained: %v", source)
			}
		})
	}
}

func TestAntigravityTranscriptDoesNotReuseEarlierAnswer(t *testing.T) {
	for name, next := range map[string]string{
		"new user turn":        `{"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"Try the next task."}`,
		"tool call commentary": `{"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"I will run the build.","tool_calls":[{"name":"run_command"}]}`,
		"thinking only":        `{"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","thinking":"Need to inspect the build."}`,
		"unfinished response":  `{"source":"MODEL","type":"PLANNER_RESPONSE","status":"RUNNING","content":"Still working."}`,
		"later error":          `{"source":"MODEL","type":"GENERIC","status":"ERROR","content":"Interrupted."}`,
		"partial last record":  `{"source":"MODEL","type":"PLANNER_RESPONSE"`,
	} {
		t.Run(name, func(t *testing.T) {
			input, _ := transcriptFixture(t, finalTranscriptRow+"\n"+next+"\n")
			if message, source := antigravityFinalMessage(input, "native-session"); message != "" || source != nil {
				t.Fatalf("reused an earlier answer: %q %v", message, source)
			}
		})
	}
}

func TestAntigravityTranscriptSelectsNewestResponseAndBoundsHistory(t *testing.T) {
	newest := strings.Replace(finalTranscriptRow, "Verified the build. Café 日本語.", "Second turn complete.", 1)
	input, _ := transcriptFixture(t, finalTranscriptRow+"\n"+`{"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"Next task."}`+"\n"+newest+"\n")
	if message, _ := antigravityFinalMessage(input, "native-session"); message != "Second turn complete." {
		t.Fatalf("did not select the newest answer: %q", message)
	}
	// Older context can exceed the read bound or contain incomplete records.
	// The final response must remain available without loading that history.
	input, _ = transcriptFixture(t, strings.Repeat("x", 5*1024*1024)+"\n{\n"+finalTranscriptRow+"\r\n\n")
	if message, source := antigravityFinalMessage(input, "native-session"); message != "Verified the build. Café 日本語." || source == nil {
		t.Fatalf("bounded tail lost the final response: %q %v", message, source)
	}
	input, _ = transcriptFixture(t, finalTranscriptRow+"\n"+strings.Repeat("x", 5*1024*1024))
	if message, source := antigravityFinalMessage(input, "native-session"); message != "" || source != nil {
		t.Fatal("retained a response outside the bounded tail")
	}
}

func TestAntigravityTranscriptRequiresMatchingFinishedConversation(t *testing.T) {
	input, file := transcriptFixture(t, finalTranscriptRow+"\n")
	for _, session := range []string{"", ".", "..", "other-session", "../native-session"} {
		if message, _ := antigravityFinalMessage(input, session); message != "" {
			t.Fatalf("accepted mismatched session %q", session)
		}
	}
	input["fullyIdle"] = false
	if message, _ := antigravityFinalMessage(input, "native-session"); message != "" {
		t.Fatal("accepted a turn with background work")
	}
	input["fullyIdle"] = true
	input["error"] = "model failed"
	if message, _ := antigravityFinalMessage(input, "native-session"); message != "" {
		t.Fatal("replaced the turn's error with an old response")
	}
	input["error"] = ""
	input["transcriptPath"] = filepath.Dir(file)
	if message, _ := antigravityFinalMessage(input, "native-session"); message != "" {
		t.Fatal("accepted a directory")
	}
	input["transcriptPath"] = file
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if message, _ := antigravityFinalMessage(input, "native-session"); message != "" {
		t.Fatal("accepted a missing transcript")
	}
}
