package main

import (
	"strings"
	"testing"
)

func TestRepositoryIdentity(t *testing.T) {
	expected := "github.com/owner/project"
	for _, remote := range []string{"https://github.com/owner/project.git", "git@github.com:owner/project.git", "ssh://git@github.com/owner/project.git", "https://user:credential@github.com/owner/project.git?token=credential"} {
		if value := repository(remote); value != expected {
			t.Fatalf("%s => %s", remote, value)
		}
	}
	for _, remote := range []string{"/workspace/project", "file:///workspace/project", "broken"} {
		if repository(remote) != "" {
			t.Fatalf("unsupported repository: %s", remote)
		}
	}
}

func TestBoundedUsefulTrace(t *testing.T) {
	if got := trace(`curl -H "Authorization: Bearer local-plugin-token" /status`, 0); got != `curl -H "Authorization: Bearer [credential]" /status` {
		t.Fatal("command authentication header was retained")
	}
	input := map[string]any{"command": "npm test", "access_token": "fixture-secret", "nested": map[string]any{"password": "fixture-password", "path": "src/app.ts"}, "output": strings.Repeat("x", 17000)}
	value := trace(input, 0).(map[string]any)
	if value["command"] != "npm test" || value["access_token"] != "[credential]" {
		t.Fatal("trace fields")
	}
	if value["nested"].(map[string]any)["path"] != "src/app.ts" {
		t.Fatal("missing useful context")
	}
	if len(value["output"].(string)) >= 17000 {
		t.Fatal("unbounded output")
	}
}

func TestOutcomeUsesExplicitEvidence(t *testing.T) {
	for _, fixture := range []struct {
		input map[string]any
		want  string
	}{
		{map[string]any{"tool_response": map[string]any{"exit_code": float64(0)}}, "tool_succeeded"},
		{map[string]any{"tool_response": map[string]any{"exit_code": float64(1)}}, "failed"},
		{map[string]any{"error": "exit status 1"}, "failed"},
		{map[string]any{"tool_response": map[string]any{"output": "done"}}, ""},
	} {
		kind, _ := outcome(fixture.input)
		if kind != fixture.want {
			t.Fatalf("wanted %s got %s", fixture.want, kind)
		}
	}
}
