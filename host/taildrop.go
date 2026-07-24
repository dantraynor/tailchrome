package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"time"

	"tailscale.com/tailcfg"
)

const (
	maxAssembledFileSize    = 50 << 20 // 50MiB cap for chunked reassembly
	maxPendingTransferParts = 1024     // guard against untrusted chunkCount allocations
	pendingTransferTTL      = 10 * time.Minute
	fileTransferTimeout     = 15 * time.Minute
)

// fileTransferAccumulator holds in-progress chunked send-file payloads.
type fileTransferAccumulator struct {
	nodeID     string
	fileName   string
	chunkCount int
	parts      [][]byte
	totalBytes int64
	updatedAt  time.Time
}

// handleSendFile decodes the base64 file data from the request and sends
// it to the target node using the Taildrop PushFile API.
func (h *Host) handleSendFile(req Request) {
	if h.localClient("send-file") == nil {
		return
	}

	if req.NodeID == "" {
		h.sendError("send-file", "nodeID is required")
		return
	}
	if req.FileName == "" {
		h.sendError("send-file", "fileName is required")
		return
	}
	if req.FileData == "" {
		h.sendError("send-file", "fileData is required")
		return
	}

	chunked := req.TransferID != "" && req.ChunkCount > 1
	if chunked {
		h.handleSendFileChunked(req)
		return
	}

	data, err := base64.StdEncoding.DecodeString(req.FileData)
	if err != nil {
		h.sendError("send-file", fmt.Sprintf("failed to decode file data: %v", err))
		return
	}

	h.pushFileData(req.NodeID, tailcfg.StableNodeID(req.NodeID), req.FileName, data, 0)
}

func (h *Host) handleSendFileChunked(req Request) {
	if req.ChunkCount < 2 || req.ChunkCount > maxPendingTransferParts {
		h.sendError(
			"send-file",
			fmt.Sprintf(
				"chunkCount must be between 2 and %d",
				maxPendingTransferParts,
			),
		)
		return
	}
	if req.ChunkIndex < 0 || req.ChunkIndex >= req.ChunkCount {
		h.sendError("send-file", fmt.Sprintf("chunkIndex %d out of range for chunkCount %d", req.ChunkIndex, req.ChunkCount))
		return
	}

	data, err := base64.StdEncoding.DecodeString(req.FileData)
	if err != nil {
		h.sendError("send-file", fmt.Sprintf("failed to decode file data: %v", err))
		return
	}

	var assembled []byte
	var badState string
	now := time.Now()

	h.pendingMu.Lock()
	if h.pendingTransfers == nil {
		h.pendingTransfers = make(map[string]*fileTransferAccumulator)
	}
	h.pruneExpiredTransfersLocked(now)
	acc, ok := h.pendingTransfers[req.TransferID]
	if !ok {
		acc = &fileTransferAccumulator{
			nodeID:     req.NodeID,
			fileName:   req.FileName,
			chunkCount: req.ChunkCount,
			parts:      make([][]byte, req.ChunkCount),
			updatedAt:  now,
		}
		h.pendingTransfers[req.TransferID] = acc
		h.schedulePendingTransferCleanup(req.TransferID)
	} else if acc.chunkCount != req.ChunkCount || acc.nodeID != req.NodeID || acc.fileName != req.FileName {
		delete(h.pendingTransfers, req.TransferID)
		badState = "chunk metadata mismatch; transfer reset"
	}
	if badState == "" && acc.parts[req.ChunkIndex] != nil {
		delete(h.pendingTransfers, req.TransferID)
		badState = "duplicate chunk"
	}
	if badState == "" && acc.totalBytes+int64(len(data)) > maxAssembledFileSize {
		delete(h.pendingTransfers, req.TransferID)
		badState = fmt.Sprintf("assembled file would exceed %d bytes", maxAssembledFileSize)
	}
	if badState != "" {
		h.pendingMu.Unlock()
		h.sendError("send-file", badState)
		return
	}

	acc.parts[req.ChunkIndex] = data
	acc.totalBytes += int64(len(data))
	acc.updatedAt = now

	filled := 0
	for _, p := range acc.parts {
		if p != nil {
			filled++
		}
	}
	complete := filled == acc.chunkCount
	if complete {
		assembled = bytes.Join(acc.parts, nil)
		delete(h.pendingTransfers, req.TransferID)
	}
	h.pendingMu.Unlock()

	if !complete {
		pct := float64(filled) / float64(acc.chunkCount) * 50
		h.send(Reply{
			Cmd: "fileSendProgress",
			FileSendProgress: &FileSendProgressReply{
				TargetNodeID: req.NodeID,
				Name:         req.FileName,
				Percent:      pct,
				Done:         false,
			},
		})
		return
	}

	h.send(Reply{
		Cmd: "fileSendProgress",
		FileSendProgress: &FileSendProgressReply{
			TargetNodeID: req.NodeID,
			Name:         req.FileName,
			Percent:      50,
			Done:         false,
		},
	})

	h.pushFileData(req.NodeID, tailcfg.StableNodeID(req.NodeID), req.FileName, assembled, 50)
}

func (h *Host) pruneExpiredTransfersLocked(now time.Time) {
	for transferID, acc := range h.pendingTransfers {
		if now.Sub(acc.updatedAt) >= pendingTransferTTL {
			delete(h.pendingTransfers, transferID)
		}
	}
}

func (h *Host) schedulePendingTransferCleanup(transferID string) {
	h.schedulePendingTransferCleanupAfter(transferID, pendingTransferTTL)
}

func (h *Host) schedulePendingTransferCleanupAfter(transferID string, delay time.Duration) {
	time.AfterFunc(delay, func() {
		h.pendingMu.Lock()

		acc, ok := h.pendingTransfers[transferID]
		if !ok {
			h.pendingMu.Unlock()
			return
		}
		age := time.Since(acc.updatedAt)
		if age >= pendingTransferTTL {
			delete(h.pendingTransfers, transferID)
			h.pendingMu.Unlock()
			return
		}
		nextDelay := pendingTransferTTL - age
		h.pendingMu.Unlock()
		h.schedulePendingTransferCleanupAfter(transferID, nextDelay)
	})
}

func (h *Host) pushFileData(peerID string, targetID tailcfg.StableNodeID, name string, data []byte, startPercent float64) {
	lc := h.localClient("send-file")
	if lc == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), fileTransferTimeout)
	transferID := h.registerActiveTransfer(cancel)
	go func() {
		defer func() {
			cancel()
			h.unregisterActiveTransfer(transferID)
		}()
		h.runPushFile(ctx, lc, peerID, targetID, name, data, startPercent)
	}()
}

func (h *Host) runPushFile(ctx context.Context, lc interface {
	PushFile(context.Context, tailcfg.StableNodeID, int64, string, io.Reader) error
}, peerID string, targetID tailcfg.StableNodeID, name string, data []byte, startPercent float64) {
	size := int64(len(data))

	h.send(Reply{
		Cmd: "fileSendProgress",
		FileSendProgress: &FileSendProgressReply{
			TargetNodeID: peerID,
			Name:         name,
			Percent:      startPercent,
			Done:         false,
		},
	})

	pr := &progressReader{
		reader: bytes.NewReader(data),
		total:  size,
		onProgress: func(sent int64) {
			percent := 100.0
			if size > 0 {
				percent = startPercent + (float64(sent)/float64(size))*(100-startPercent)
			}
			if percent > 100 {
				percent = 100
			}
			h.send(Reply{
				Cmd: "fileSendProgress",
				FileSendProgress: &FileSendProgressReply{
					TargetNodeID: peerID,
					Name:         name,
					Percent:      percent,
					Done:         false,
				},
			})
		},
	}

	err := lc.PushFile(ctx, targetID, size, name, pr)
	if err != nil {
		h.send(Reply{
			Cmd: "fileSendProgress",
			FileSendProgress: &FileSendProgressReply{
				TargetNodeID: peerID,
				Name:         name,
				Percent:      0,
				Done:         true,
				Error:        fmt.Sprintf("failed to send file: %v", err),
			},
		})
		return
	}

	h.send(Reply{
		Cmd: "fileSendProgress",
		FileSendProgress: &FileSendProgressReply{
			TargetNodeID: peerID,
			Name:         name,
			Percent:      100,
			Done:         true,
		},
	})
}

func (h *Host) registerActiveTransfer(cancel context.CancelFunc) uint64 {
	h.activeMu.Lock()
	defer h.activeMu.Unlock()
	if h.activeTransfers == nil {
		h.activeTransfers = make(map[uint64]context.CancelFunc)
	}
	h.nextTransferID++
	id := h.nextTransferID
	h.activeTransfers[id] = cancel
	return id
}

func (h *Host) unregisterActiveTransfer(id uint64) {
	h.activeMu.Lock()
	delete(h.activeTransfers, id)
	h.activeMu.Unlock()
}

// cancelTransfers drops partial uploads and cancels active Taildrop requests.
// It is called whenever a browser profile/session is replaced.
func (h *Host) cancelTransfers() {
	h.pendingMu.Lock()
	h.pendingTransfers = nil
	h.pendingMu.Unlock()

	h.activeMu.Lock()
	cancels := make([]context.CancelFunc, 0, len(h.activeTransfers))
	for _, cancel := range h.activeTransfers {
		cancels = append(cancels, cancel)
	}
	h.activeTransfers = nil
	h.activeMu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

// progressReader wraps an io.Reader and calls onProgress with the total
// bytes read so far after each Read call.
type progressReader struct {
	reader     io.Reader
	total      int64
	sent       int64
	onProgress func(sent int64)
	// chunkSize controls how often progress is reported.
	// If zero, progress is reported on every read.
	lastReport int64
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.reader.Read(p)
	pr.sent += int64(n)

	// Report progress at most every 10% to avoid flooding the extension.
	threshold := pr.total / 10
	if threshold < 1 {
		threshold = 1
	}
	if pr.sent-pr.lastReport >= threshold || err == io.EOF {
		pr.lastReport = pr.sent
		if pr.onProgress != nil {
			pr.onProgress(pr.sent)
		}
	}

	return n, err
}
