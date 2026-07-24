package main

import (
	"context"
	"testing"
	"time"
)

func TestCancelStartupCorrectionWaitsForWorker(t *testing.T) {
	h := newHost(nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	cancelObserved := make(chan struct{})
	releaseWorker := make(chan struct{})

	h.correctionCancel = cancel
	h.correctionDone = done
	go func() {
		<-ctx.Done()
		close(cancelObserved)
		<-releaseWorker
		close(done)
	}()

	returned := make(chan struct{})
	go func() {
		h.cancelStartupCorrection()
		close(returned)
	}()

	<-cancelObserved
	select {
	case <-returned:
		t.Fatal("cancelStartupCorrection returned before the worker stopped")
	default:
	}

	close(releaseWorker)
	<-returned
	if h.correctionCancel != nil || h.correctionDone != nil {
		t.Fatal("startup-correction handles were not cleared")
	}
}

func TestCancelStartupCorrectionBoundedWhenWorkerWedged(t *testing.T) {
	oldGrace := correctionCancelGrace
	correctionCancelGrace = 50 * time.Millisecond
	defer func() { correctionCancelGrace = oldGrace }()

	h := newHost(nil, nil)
	_, cancel := context.WithCancel(context.Background())
	h.correctionCancel = cancel
	// A worker wedged inside the local API never closes done. Dispatch must
	// still get its goroutine back within the grace period.
	h.correctionDone = make(chan struct{})

	returned := make(chan struct{})
	go func() {
		h.cancelStartupCorrection()
		close(returned)
	}()

	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelStartupCorrection did not return within the grace period")
	}
	if h.correctionCancel != nil || h.correctionDone != nil {
		t.Fatal("startup-correction handles were not cleared")
	}
}

func TestCancelStartupCorrectionIdempotent(t *testing.T) {
	h := newHost(nil, nil)
	// No correction pending: must be a no-op.
	h.cancelStartupCorrection()

	_, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	close(done)
	h.correctionCancel = cancel
	h.correctionDone = done
	h.cancelStartupCorrection()
	// A second call after the handles were cleared must not panic or block.
	h.cancelStartupCorrection()
}
