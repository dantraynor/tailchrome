package main

import (
	"context"
	"testing"
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
