import { describe, it, expect, beforeEach } from 'vitest';
import { RiskEngine } from '../src/position/risk-engine';
import { PnLTracker } from '../src/position/pnl-tracker';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const goodCandidate = {
  symbol: 'WETH',
  leverage: 2,
  marginUsd: 1000,
  netApyBps: 200,
  projectedHealthFactor: 1.65,
};

describe('RiskEngine', () => {
  let engine: RiskEngine;

  beforeEach(() => {
    engine = new RiskEngine({ cooldownMs: 0 });
  });

  it('allows a sound candidate', () => {
    expect(engine.canOpen(goodCandidate).allowed).toBe(true);
  });

  it('blocks oversize margins', () => {
    engine.updateParams({ maxMarginUsd: 500 });
    const res = engine.canOpen(goodCandidate);
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/exceeds limit/);
  });

  it('blocks low-yield loops', () => {
    const res = engine.canOpen({ ...goodCandidate, netApyBps: 10 });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/below minimum/);
  });

  it('blocks unsafe projected health factors', () => {
    const res = engine.canOpen({ ...goodCandidate, projectedHealthFactor: 1.01 });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/HF/);
  });

  it('enforces one open position at a time', () => {
    engine.recordOpen(goodCandidate, 1000n);
    const res = engine.canOpen(goodCandidate);
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/already open/);
  });

  it('enforces cooldown between actions', () => {
    engine.updateParams({ cooldownMs: 60_000 });
    engine.recordOpen(goodCandidate, 1000n);
    engine.recordClose(engine.getAllPositions()[0].id);
    const res = engine.canOpen(goodCandidate);
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/Cooldown/);
  });

  it('tracks open and closed positions', () => {
    const pos = engine.recordOpen(goodCandidate, 1000n, '0xabc');
    expect(engine.getOpenPositions()).toHaveLength(1);

    engine.recordClose(pos.id, '0xdef', 12.5);
    expect(engine.getOpenPositions()).toHaveLength(0);
    const closed = engine.getAllPositions()[0];
    expect(closed.status).toBe('closed');
    expect(closed.realizedPnlUsd).toBe(12.5);
  });
});

describe('PnLTracker', () => {
  const tmpFile = path.join(os.tmpdir(), `pnl-test-${process.pid}.json`);

  beforeEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it('persists records across instances', () => {
    const tracker = new PnLTracker(tmpFile);
    tracker.record({
      id: 'loop-1',
      openedAt: 1000,
      closedAt: 2000,
      asset: 'WETH',
      leverage: 2,
      marginUsd: 1000,
      durationHours: 24,
      grossYieldUsd: 5,
      gasCostUsd: 0.5,
      netPnlUsd: 4.5,
    });

    const reloaded = new PnLTracker(tmpFile);
    expect(reloaded.getRecords()).toHaveLength(1);
    expect(reloaded.getSummary().totalNetPnlUsd).toBe(4.5);
  });

  it('summarizes multiple positions', () => {
    const tracker = new PnLTracker(tmpFile);
    tracker.record({
      id: 'a',
      openedAt: 0,
      closedAt: 0,
      asset: 'WETH',
      leverage: 2,
      marginUsd: 100,
      durationHours: 10,
      grossYieldUsd: 1,
      gasCostUsd: 0.1,
      netPnlUsd: 0.9,
    });
    tracker.record({
      id: 'b',
      openedAt: 0,
      closedAt: 0,
      asset: 'cbETH',
      leverage: 3,
      marginUsd: 200,
      durationHours: 20,
      grossYieldUsd: 4,
      gasCostUsd: 0.2,
      netPnlUsd: 3.8,
    });

    const s = tracker.getSummary();
    expect(s.totalPositions).toBe(2);
    expect(s.totalNetPnlUsd).toBeCloseTo(4.7, 5);
    expect(s.totalGasCostUsd).toBeCloseTo(0.3, 5);
    expect(s.averageHoldHours).toBe(15);
    expect(s.bestPositionUsd).toBeCloseTo(3.8, 5);
    expect(s.worstPositionUsd).toBeCloseTo(0.9, 5);
  });

  it('survives a corrupt file', () => {
    fs.writeFileSync(tmpFile, '{not json');
    const tracker = new PnLTracker(tmpFile);
    expect(tracker.getRecords()).toHaveLength(0);
  });
});
