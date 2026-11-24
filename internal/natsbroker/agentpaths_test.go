package natsbroker

import (
	"context"
	"io"
	"log"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/openweft/weft-microvm-agent/pkg/containers"
	"github.com/openweft/weft-microvm-agent/pkg/firewall"
	"github.com/openweft/weft-microvm-agent/pkg/firewallstatus"
	"github.com/openweft/weft-microvm-agent/pkg/mesh"
	"github.com/openweft/weft-microvm-agent/pkg/mounts"
	"github.com/openweft/weft-microvm-agent/pkg/properties"
	"github.com/openweft/weft-microvm-agent/pkg/sshkeys"
	"github.com/openweft/weft-microvm-init/pkg/pod"
)

// guestConn connects as the VM with the credential AddGuest mints and
// collects every asynchronous permissions violation the server reports.
func guestConn(t *testing.T, e *Embedded, vmID string) (*nats.Conn, func() []string) {
	t.Helper()
	user, pass, err := e.AddGuest(vmID)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var viol []string
	nc, err := nats.Connect(e.URL, nats.UserInfo(user, pass),
		nats.ErrorHandler(func(_ *nats.Conn, _ *nats.Subscription, err error) {
			mu.Lock()
			viol = append(viol, err.Error())
			mu.Unlock()
		}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(nc.Close)
	return nc, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), viol...)
	}
}

// TestAgentJetStreamPathsUnderGuestCredential runs the guest agent's real
// subscriber code (pkg/mounts, pkg/containers) under the credential
// loom-server mints, against the real embedded broker: the replay must be
// delivered, the agent must not fall back to core NATS, and the server must
// report no permissions violation.
func TestAgentJetStreamPathsUnderGuestCredential(t *testing.T) {
	seed := newSeed(t)
	e := start(t, Options{NkeySeed: seed})
	loom := loomConn(t, e, seed)
	ljs, err := loom.JetStream()
	if err != nil {
		t.Fatal(err)
	}
	const vm = "vmaaa"
	if _, err := ljs.Publish("weft.mounts."+vm, []byte(`{"id":"m1","action":"unmount","mount_point":"/mnt/a"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := ljs.Publish("weft.containers."+vm, []byte(`{"version":1,"containers":[]}`)); err != nil {
		t.Fatal(err)
	}

	nc, violations := guestConn(t, e, vm)
	logs := &strings.Builder{}
	var lmu sync.Mutex
	logger := log.New(lockedWriter{&lmu, logs}, "", 0)

	applied := make(chan struct{}, 4)
	msub, err := mounts.NewSubscriber(nc, vm, func(pod.ShareMount) error {
		applied <- struct{}{}
		return nil
	}, logger).Start()
	if err != nil {
		t.Fatalf("mounts subscriber: %v", err)
	}
	t.Cleanup(func() { _ = msub.Unsubscribe() })
	csub, err := containers.NewSubscriber(nc, vm, noRuntime{}, logger).Start(context.Background())
	if err != nil {
		t.Errorf("containers subscriber: %v", err)
	} else {
		t.Cleanup(func() { _ = csub.Unsubscribe() })
	}

	select {
	case <-applied:
	case <-time.After(5 * time.Second):
		t.Error("the mounts replay was never delivered")
	}
	// Let acks and any denied publish round-trip before reading violations.
	if err := nc.FlushTimeout(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)

	lmu.Lock()
	out := logs.String()
	lmu.Unlock()
	if strings.Contains(out, "falling back") || strings.Contains(out, "failed") {
		t.Errorf("the agent degraded to core NATS:\n%s", out)
	}
	for _, v := range violations() {
		t.Errorf("permissions violation: %s", v)
	}
}

// TestAgentCoreSubjectsUnderGuestCredential covers the agent's core-NATS
// subscriptions (mesh, firewall, properties, sshkeys) and its status/log
// publishes: every one is on the VM's own subject and must be allowed.
func TestAgentCoreSubjectsUnderGuestCredential(t *testing.T) {
	seed := newSeed(t)
	e := start(t, Options{NkeySeed: seed})
	const vm = "vmaaa"
	nc, violations := guestConn(t, e, vm)
	lg := log.New(io.Discard, "", 0)

	subs := map[string]func() (*nats.Subscription, error){
		"mesh":       mesh.NewSubscriber(nc, vm, nil, lg).Start,
		"firewall":   firewall.NewSubscriber(nc, vm, nil, lg).Start,
		"properties": properties.NewSubscriber(nc, vm, nil, lg).Start,
		"sshkeys":    sshkeys.NewSubscriber(nc, vm, nil, lg).Start,
	}
	for name, start := range subs {
		s, err := start()
		if err != nil {
			t.Errorf("%s subscriber: %v", name, err)
			continue
		}
		t.Cleanup(func() { _ = s.Unsubscribe() })
	}
	for _, subj := range []string{
		firewallstatus.Subject(vm),
		"weft.microvm-agent." + vm + ".log",
		"weft.agent." + vm + ".up",
		"weft.heartbeat." + vm,
	} {
		if err := nc.Publish(subj, []byte("x")); err != nil {
			t.Errorf("publish %s: %v", subj, err)
		}
	}
	if err := nc.FlushTimeout(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	for _, v := range violations() {
		t.Errorf("permissions violation: %s", v)
	}
}

// noRuntime is a containers.Runtime that runs nothing (the package's own
// stub is not built on linux).
type noRuntime struct{}

func (noRuntime) Pull(context.Context, string) error                 { return nil }
func (noRuntime) Start(context.Context, pod.WorkloadContainer) error { return nil }
func (noRuntime) Stop(context.Context, string) error                 { return nil }
func (noRuntime) Running(context.Context) ([]string, error)          { return nil, nil }

type lockedWriter struct {
	mu *sync.Mutex
	w  io.Writer
}

func (l lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}
