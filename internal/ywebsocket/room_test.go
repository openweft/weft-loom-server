package ywebsocket

import (
	"sync"
	"testing"
	"time"
)

func TestHub_TwoClientsRelayBetween(t *testing.T) {
	h := NewHub()
	a := h.Join("room1", "client-a")
	b := h.Join("room1", "client-b")
	defer a.Leave()
	defer b.Leave()

	// a sends ; b should receive ; a should NOT receive own message
	a.Send([]byte("hello"))

	select {
	case got := <-b.Recv():
		if string(got) != "hello" {
			t.Errorf("b got %q ; want hello", got)
		}
	case <-time.After(time.Second):
		t.Fatal("b did not receive a's message in 1s")
	}

	// Verify a does NOT receive its own message (echo-suppression).
	select {
	case echo := <-a.Recv():
		t.Errorf("a received its own echo : %q", echo)
	case <-time.After(50 * time.Millisecond):
		// good : no echo
	}
}

func TestHub_DifferentRoomsIsolated(t *testing.T) {
	h := NewHub()
	r1 := h.Join("room1", "c1")
	r2 := h.Join("room2", "c2")
	defer r1.Leave()
	defer r2.Leave()

	r1.Send([]byte("private"))

	select {
	case leak := <-r2.Recv():
		t.Errorf("cross-room leak : r2 received %q from r1", leak)
	case <-time.After(50 * time.Millisecond):
		// good
	}
}

func TestHub_GCEmptyRooms(t *testing.T) {
	h := NewHub()
	m := h.Join("room1", "c1")
	if len(h.rooms) != 1 {
		t.Errorf("want 1 room after join ; got %d", len(h.rooms))
	}
	m.Leave()
	// After last member leaves, the room should be GC'd.
	if len(h.rooms) != 0 {
		t.Errorf("want 0 rooms after last leave ; got %d", len(h.rooms))
	}
}

func TestHub_SlowPeerDoesNotBlockHub(t *testing.T) {
	// Slow peer = never reads its Recv channel. The fast peer's
	// Send must not block on the slow peer's full buffer.
	h := NewHub()
	slow := h.Join("room", "slow")
	fast := h.Join("room", "fast")
	defer slow.Leave()
	defer fast.Leave()

	// Send 100 messages from fast ; without back-pressure on slow,
	// this must complete promptly even if slow never reads.
	done := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			fast.Send([]byte("x"))
		}
		close(done)
	}()
	select {
	case <-done:
		// good
	case <-time.After(2 * time.Second):
		t.Fatal("slow peer blocked hub for >2s")
	}
}

func TestHub_LeaveIdempotent(t *testing.T) {
	h := NewHub()
	m := h.Join("room", "c")
	m.Leave()
	m.Leave() // second call must not panic
}

func TestHub_ConcurrentJoinSendLeave(t *testing.T) {
	// 50 goroutines each join, send 10 messages, leave. The hub
	// must not race or panic.
	h := NewHub()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			m := h.Join("shared", ConnID(string(rune('a'+i%26))))
			for j := 0; j < 10; j++ {
				m.Send([]byte{byte(j)})
			}
			m.Leave()
		}(i)
	}
	wg.Wait()
	if len(h.rooms) != 0 {
		t.Errorf("rooms leaked after burst : %d", len(h.rooms))
	}
}
