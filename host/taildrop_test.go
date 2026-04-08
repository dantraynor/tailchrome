package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func decodeReply(t *testing.T, buf *bytes.Buffer) Reply {
	t.Helper()

	var length uint32
	if err := binary.Read(buf, binary.LittleEndian, &length); err != nil {
		t.Fatalf("read length: %v", err)
	}

	data := make([]byte, length)
	if _, err := buf.Read(data); err != nil {
		t.Fatalf("read body: %v", err)
	}

	var reply Reply
	if err := json.Unmarshal(data, &reply); err != nil {
		t.Fatalf("unmarshal reply: %v", err)
	}
	return reply
}

func decodeAllReplies(t *testing.T, buf *bytes.Buffer) []Reply {
	t.Helper()
	var replies []Reply
	for buf.Len() > 0 {
		replies = append(replies, decodeReply(t, buf))
	}
	return replies
}

func b64(s string) string {
	return base64.StdEncoding.EncodeToString([]byte(s))
}

func TestHandleSendFileChunkedRejectsLargeChunkCount(t *testing.T) {
	var out bytes.Buffer
	h := newHost(nil, &out)

	h.handleSendFileChunked(Request{
		Cmd:        "send-file",
		NodeID:     "peer-1",
		FileName:   "large.txt",
		FileData:   "YQ==",
		TransferID: "tx-1",
		ChunkIndex: 0,
		ChunkCount: maxPendingTransferParts + 1,
	})

	reply := decodeReply(t, &out)
	if reply.Error == nil {
		t.Fatal("expected error reply")
	}
	if !strings.Contains(reply.Error.Message, "chunkCount must be between 2") {
		t.Fatalf("unexpected error: %q", reply.Error.Message)
	}
	if len(h.pendingTransfers) != 0 {
		t.Fatalf("expected no pending transfers, got %d", len(h.pendingTransfers))
	}
}

func TestHandleSendFileChunkedAssemblyProgress(t *testing.T) {
	var out bytes.Buffer
	h := newHost(nil, &out)
	h.pendingTransfers = make(map[string]*fileTransferAccumulator)

	for i := 0; i < 2; i++ {
		h.handleSendFileChunked(Request{
			Cmd:        "send-file",
			NodeID:     "peer-1",
			FileName:   "hello.txt",
			FileData:   b64("chunk"),
			TransferID: "tx-progress",
			ChunkIndex: i,
			ChunkCount: 3,
		})
	}

	replies := decodeAllReplies(t, &out)

	var percents []float64
	for _, r := range replies {
		if r.FileSendProgress != nil {
			percents = append(percents, r.FileSendProgress.Percent)
		}
	}

	if len(percents) < 2 {
		t.Fatalf("expected at least 2 progress updates, got %d", len(percents))
	}
	for i := 1; i < len(percents); i++ {
		if percents[i] < percents[i-1] {
			t.Fatalf("progress went backward: %v", percents)
		}
	}
	for _, p := range percents {
		if p > 50 {
			t.Fatalf("assembly-phase progress should be <= 50%%, got %.1f", p)
		}
	}

	if _, ok := h.pendingTransfers["tx-progress"]; !ok {
		t.Fatal("expected transfer to still be pending after 2 of 3 chunks")
	}
}

func TestHandleSendFileChunkedAccumulatesData(t *testing.T) {
	h := newHost(nil, &bytes.Buffer{})
	h.pendingTransfers = make(map[string]*fileTransferAccumulator)

	parts := []string{"Hello", ", ", "world!"}

	for i := 0; i < len(parts)-1; i++ {
		h.handleSendFileChunked(Request{
			Cmd:        "send-file",
			NodeID:     "peer-1",
			FileName:   "hello.txt",
			FileData:   b64(parts[i]),
			TransferID: "tx-data",
			ChunkIndex: i,
			ChunkCount: 3,
		})
	}

	h.pendingMu.Lock()
	acc := h.pendingTransfers["tx-data"]
	h.pendingMu.Unlock()

	if acc == nil {
		t.Fatal("expected pending transfer after 2 of 3 chunks")
	}
	if acc.chunkCount != 3 {
		t.Fatalf("expected chunkCount 3, got %d", acc.chunkCount)
	}
	if acc.parts[0] == nil || acc.parts[1] == nil {
		t.Fatal("expected parts 0 and 1 to be filled")
	}
	if acc.parts[2] != nil {
		t.Fatal("expected part 2 to be nil before final chunk")
	}
	if string(acc.parts[0]) != "Hello" {
		t.Fatalf("part 0: expected 'Hello', got %q", string(acc.parts[0]))
	}
	if string(acc.parts[1]) != ", " {
		t.Fatalf("part 1: expected ', ', got %q", string(acc.parts[1]))
	}
	expected := int64(len("Hello") + len(", "))
	if acc.totalBytes != expected {
		t.Fatalf("expected totalBytes %d, got %d", expected, acc.totalBytes)
	}
}

func TestHandleSendFileChunkedRejectsDuplicate(t *testing.T) {
	var out bytes.Buffer
	h := newHost(nil, &out)
	h.pendingTransfers = make(map[string]*fileTransferAccumulator)

	req := Request{
		Cmd:        "send-file",
		NodeID:     "peer-1",
		FileName:   "dup.txt",
		FileData:   b64("data"),
		TransferID: "tx-dup",
		ChunkIndex: 0,
		ChunkCount: 2,
	}

	h.handleSendFileChunked(req)
	out.Reset()

	h.handleSendFileChunked(req)
	reply := decodeReply(t, &out)
	if reply.Error == nil || !strings.Contains(reply.Error.Message, "duplicate chunk") {
		t.Fatalf("expected duplicate chunk error, got: %+v", reply)
	}
}

func TestHandleSendFileChunkedRejectsMismatch(t *testing.T) {
	var out bytes.Buffer
	h := newHost(nil, &out)
	h.pendingTransfers = make(map[string]*fileTransferAccumulator)

	h.handleSendFileChunked(Request{
		Cmd:        "send-file",
		NodeID:     "peer-1",
		FileName:   "a.txt",
		FileData:   b64("a"),
		TransferID: "tx-mismatch",
		ChunkIndex: 0,
		ChunkCount: 3,
	})
	out.Reset()

	h.handleSendFileChunked(Request{
		Cmd:        "send-file",
		NodeID:     "peer-1",
		FileName:   "b.txt",
		FileData:   b64("b"),
		TransferID: "tx-mismatch",
		ChunkIndex: 1,
		ChunkCount: 3,
	})
	reply := decodeReply(t, &out)
	if reply.Error == nil || !strings.Contains(reply.Error.Message, "mismatch") {
		t.Fatalf("expected mismatch error, got: %+v", reply)
	}
}

func TestHandleSendFileChunkedProgressMonotonic(t *testing.T) {
	var out bytes.Buffer
	h := newHost(nil, &out)
	h.pendingTransfers = make(map[string]*fileTransferAccumulator)

	for i := 0; i < 4; i++ {
		h.handleSendFileChunked(Request{
			Cmd:        "send-file",
			NodeID:     "peer-1",
			FileName:   "mono.txt",
			FileData:   b64("x"),
			TransferID: "tx-mono",
			ChunkIndex: i,
			ChunkCount: 5,
		})
	}

	replies := decodeAllReplies(t, &out)

	var percents []float64
	for _, r := range replies {
		if r.FileSendProgress != nil {
			percents = append(percents, r.FileSendProgress.Percent)
		}
	}

	if len(percents) < 4 {
		t.Fatalf("expected at least 4 progress updates, got %d", len(percents))
	}

	for i := 1; i < len(percents); i++ {
		if percents[i] < percents[i-1] {
			t.Fatalf("progress not monotonic at index %d: %v", i, percents)
		}
	}

	for _, p := range percents {
		if p > 50 {
			t.Fatalf("assembly-phase progress should be <= 50%%, got %.1f", p)
		}
	}
}

func TestPruneExpiredTransfersLockedRemovesIdleTransfers(t *testing.T) {
	h := newHost(nil, &bytes.Buffer{})
	now := time.Now()
	h.pendingTransfers = map[string]*fileTransferAccumulator{
		"stale": {updatedAt: now.Add(-pendingTransferTTL - time.Second)},
		"fresh": {updatedAt: now.Add(-pendingTransferTTL / 2)},
	}

	h.pruneExpiredTransfersLocked(now)

	if _, ok := h.pendingTransfers["stale"]; ok {
		t.Fatal("expected stale transfer to be removed")
	}
	if _, ok := h.pendingTransfers["fresh"]; !ok {
		t.Fatal("expected fresh transfer to remain")
	}
}

func TestScheduleCleanupReschedulesForActiveTransfer(t *testing.T) {
	h := newHost(nil, &bytes.Buffer{})

	// Set updatedAt to just under the TTL so the first cleanup pass
	// sees it as "still active" but reschedules with a very short delay.
	almostExpired := time.Now().Add(-pendingTransferTTL + 20*time.Millisecond)

	h.pendingMu.Lock()
	h.pendingTransfers = map[string]*fileTransferAccumulator{
		"active": {updatedAt: almostExpired},
	}
	h.pendingMu.Unlock()

	// First cleanup fires in 10ms; sees age ~= TTL-10ms, reschedules ~20ms.
	h.schedulePendingTransferCleanupAfter("active", 10*time.Millisecond)

	time.Sleep(15 * time.Millisecond)

	h.pendingMu.Lock()
	_, stillThere := h.pendingTransfers["active"]
	h.pendingMu.Unlock()

	if !stillThere {
		t.Fatal("transfer should survive first cleanup (not yet expired)")
	}

	// Wait for the rescheduled timer to fire and find it expired.
	time.Sleep(100 * time.Millisecond)

	h.pendingMu.Lock()
	_, stillThere = h.pendingTransfers["active"]
	h.pendingMu.Unlock()

	if stillThere {
		t.Fatal("transfer should be cleaned up by rescheduled timer after expiry")
	}
}
