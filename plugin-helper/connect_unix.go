//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func detachConnection(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
