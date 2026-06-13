package workspace

// nats_conn.go — adapter that wraps a real *nats.Conn behind the
// workspace.NATSPubSub interface, so the shell handler can stay
// testable with an in-memory stub while production runs through
// the actual broker.

import (
	"github.com/nats-io/nats.go"
)

// natsConn is the production wrapper. Pure forwarder ; the only
// reason it exists is to map the nats.Conn signature to the
// trimmed-down NATSPubSub the handler depends on.
type natsConn struct {
	nc *nats.Conn
}

// NewNATSConn wraps nc as a NATSPubSub. Caller retains ownership
// of nc — closing it after is fine, the handler's subscriptions
// fail cleanly through their cb (the cb is best-effort).
func NewNATSConn(nc *nats.Conn) NATSPubSub {
	return &natsConn{nc: nc}
}

func (c *natsConn) Publish(subject string, data []byte) error {
	return c.nc.Publish(subject, data)
}

func (c *natsConn) Subscribe(subject string, cb func(subj string, data []byte)) (Unsubscriber, error) {
	sub, err := c.nc.Subscribe(subject, func(m *nats.Msg) { cb(m.Subject, m.Data) })
	if err != nil {
		return nil, err
	}
	return &natsSub{sub: sub}, nil
}

type natsSub struct{ sub *nats.Subscription }

func (s *natsSub) Unsubscribe() error { return s.sub.Unsubscribe() }
