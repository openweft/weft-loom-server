package compile

// dispatch.go — NATS publication of per-VM share-mount config to
// the openweft event bus. The compile microVM's in-guest
// weft-microvm-agent subscribes to the per-VM subject
// `weft.mounts.<vmID>` and applies any pod.ShareMount it receives
// — same Subscriber+ApplyFunc pattern used for mesh, sshkeys, and
// firewall.
//
// Why publish instead of passing --cubefs on the CLI : openweft's
// cross-daemon contract is "pull/reconcile, no synchronous push"
// (cf. memory `openweft_pull_model`). The agent already speaks
// NATS for its other concerns ; the share-mount config is just one
// more datum on the same bus, with the same operational tooling
// (`nats sub weft.mounts.>` for debug, JetStream LastPerSubject for
// at-boot delivery).
//
// Boot-time delivery guarantee : the agent's mounts Subscriber
// auto-ensures a JetStream stream `weft-mounts` with `weft.mounts.*`
// subjects + LastPerSubject retention on its first connect, so the
// publish-before-boot path is reliable out of the box — no operator
// runbook step required. The fall-back to core NATS only kicks in
// when the broker is JetStream-less (rare ; CI / unit-test brokers
// mostly).

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/openweft/weft-microvm-init/pkg/pod"
)

// natsURL pulls the NATS endpoint from env. Same convention every
// other openweft component follows (weft-slognats, weft-doctor, …).
func natsURL() string {
	if v := os.Getenv("WEFT_NATS_URL"); v != "" {
		return v
	}
	return nats.DefaultURL
}

// publishCubeFSMount publishes ONE pod.ShareMount intent to the
// per-VM subject so the in-guest weft-microvm-agent can apply it
// via cubefs.Registry.Apply. Idempotent — re-publishing with the
// same ID replaces the previous state on the agent side.
//
// Connection is opened, used, and closed in-method. For a workload
// that publishes thousands of mounts per minute we'd want a shared
// pool ; loom-server's compile rate is well under that.
func publishCubeFSMount(ctx context.Context, vmID string, mount pod.ShareMount) error {
	nc, err := nats.Connect(natsURL(),
		nats.Name("weft-loom-server-dispatch"),
		nats.Timeout(5*time.Second),
		nats.ReconnectWait(1*time.Second),
		nats.MaxReconnects(3),
	)
	if err != nil {
		return fmt.Errorf("nats connect %s: %w", natsURL(), err)
	}
	defer nc.Close()

	subject := "weft.mounts." + vmID
	payload, err := json.Marshal(mount)
	if err != nil {
		return fmt.Errorf("marshal share-mount: %w", err)
	}

	// JetStream publish when the operator has configured a stream
	// covering weft.mounts.* (the LastPerSubject recipe in this
	// file's header). The PublishAsync->Wait dance hands the message
	// to the durable stream so a late-subscribing agent still sees
	// it. Falls back to plain core-NATS publish when JetStream isn't
	// configured — useful in dev where the message races VM boot
	// and may be lost ; the agent's next reconnect / heartbeat
	// triggers a re-publish.
	js, jsErr := nc.JetStream()
	if jsErr == nil {
		if _, err := js.Publish(subject, payload, nats.Context(ctx)); err == nil {
			return nil
		}
		// JetStream publish failed (stream missing, no quota, …). Fall
		// through to core NATS so dev environments without a stream
		// still get something on the wire.
	}
	if err := nc.Publish(subject, payload); err != nil {
		return fmt.Errorf("publish %s: %w", subject, err)
	}
	if err := nc.Flush(); err != nil {
		return fmt.Errorf("flush %s: %w", subject, err)
	}
	return nil
}

// cubefsMountForLoom builds a pod.ShareMount targeting the cluster's
// CubeFS volume that holds every project's working tree. The mount
// surface inside the compile VM is /workspace, matching the contract
// the weft-loom-* OCI images expect (see each Dockerfile header).
func cubefsMountForLoom() pod.ShareMount {
	masters := splitCSV(os.Getenv("WEFT_LOOM_CUBEFS_MASTERS"))
	volume := os.Getenv("WEFT_LOOM_CUBEFS_VOLUME")
	return pod.ShareMount{
		ID:         "loom-projects",
		Backend:    pod.BackendCubeFS,
		MountPoint: "/workspace",
		CubeFS: &pod.CubeFSMount{
			Volume:  volume,
			Masters: masters,
		},
	}
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	out := []string{}
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == ',' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}
