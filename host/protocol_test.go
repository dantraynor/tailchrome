package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"
)

func appendNativeMessage(t *testing.T, dst *bytes.Buffer, payload []byte) {
	t.Helper()
	if err := binary.Write(dst, binary.LittleEndian, uint32(len(payload))); err != nil {
		t.Fatal(err)
	}
	if _, err := dst.Write(payload); err != nil {
		t.Fatal(err)
	}
}

func TestReadMessagesContinuesAfterInvalidJSON(t *testing.T) {
	var in, out bytes.Buffer
	appendNativeMessage(t, &in, []byte(`{"cmd":`))
	appendNativeMessage(t, &in, []byte(`{"cmd":"ping"}`))

	newHost(&in, &out).readMessages()
	replies := decodeAllReplies(t, &out)
	if len(replies) != 2 || replies[0].Error == nil || replies[1].Pong == nil {
		t.Fatalf("unexpected replies: %#v", replies)
	}
	if !strings.Contains(replies[0].Error.Message, "invalid JSON") {
		t.Fatalf("error message = %q, want it to identify invalid JSON", replies[0].Error.Message)
	}
}

func TestReadMessagesDrainsOversizedFrame(t *testing.T) {
	var in, out bytes.Buffer
	oversized := bytes.Repeat([]byte("x"), maxMessageSize+1)
	appendNativeMessage(t, &in, oversized)
	appendNativeMessage(t, &in, []byte(`{"cmd":"ping"}`))

	newHost(&in, &out).readMessages()
	replies := decodeAllReplies(t, &out)
	if len(replies) != 2 || replies[0].Error == nil || replies[1].Pong == nil {
		t.Fatalf("protocol stream did not recover: %#v", replies)
	}
}

func TestSendTruncatesOversizedStatus(t *testing.T) {
	var out bytes.Buffer
	h := newHost(nil, &out)
	peers := make([]PeerInfo, 2200)
	for i := range peers {
		peers[i] = PeerInfo{
			ID:       strings.Repeat("i", 512),
			Hostname: strings.Repeat("h", 512),
		}
	}
	h.send(Reply{Cmd: "status", Status: &StatusUpdate{Peers: peers}})

	var frameLength uint32
	if err := binary.Read(&out, binary.LittleEndian, &frameLength); err != nil {
		t.Fatal(err)
	}
	if frameLength > maxMessageSize {
		t.Fatalf("frame length = %d, max = %d", frameLength, maxMessageSize)
	}
	payload := make([]byte, frameLength)
	if _, err := out.Read(payload); err != nil {
		t.Fatal(err)
	}
	var reply Reply
	if err := json.Unmarshal(payload, &reply); err != nil {
		t.Fatal(err)
	}
	if reply.Status == nil || !reply.Status.PeersTruncated {
		t.Fatalf("expected explicit truncation metadata: %#v", reply.Status)
	}
	if reply.Status.TotalPeers != len(peers) {
		t.Fatalf("TotalPeers = %d, want %d", reply.Status.TotalPeers, len(peers))
	}
	if len(reply.Status.Peers) >= len(peers) {
		t.Fatalf("peer list was not truncated: %d", len(reply.Status.Peers))
	}
}

func TestSendDropsReplyStillOversizedAfterTruncation(t *testing.T) {
	var out bytes.Buffer
	h := newHost(nil, &out)
	peers := make([]PeerInfo, 100)
	for i := range peers {
		peers[i] = PeerInfo{
			ID:       strings.Repeat("i", 64),
			Hostname: strings.Repeat("h", 64),
		}
	}
	// Health alone is larger than maxMessageSize, so truncateStatusReply can
	// drop every peer and the reply still won't fit.
	oversizedHealth := []string{strings.Repeat("h", maxMessageSize*2)}

	h.send(Reply{Cmd: "status", Status: &StatusUpdate{Peers: peers, Health: oversizedHealth}})

	if out.Len() != 0 {
		t.Fatalf("expected oversized reply to be dropped, but %d bytes were written", out.Len())
	}
}

func TestHandleInitRejectsUnsafeProfileIDs(t *testing.T) {
	for _, initID := range []string{"", "../other-profile", "with/slash", strings.Repeat("a", 65)} {
		t.Run(initID, func(t *testing.T) {
			var out bytes.Buffer
			h := newHost(nil, &out)
			h.handleInit(Request{Cmd: "init", InitID: initID})
			reply := decodeReply(t, &out)
			if reply.Init == nil || reply.Init.Error == "" {
				t.Fatalf("initID %q was accepted", initID)
			}
		})
	}
}
