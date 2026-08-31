import fs from 'node:fs';
import path from 'node:path';

/**
 * PnL record for one closed loop position.
 */
export interface PnLRecord {
  id: string;
  openedAt: number;
  closedAt: number;
  asset: string;
  leverage: number;
  marginUsd: number;
  durationHours: number;
  grossYieldUsd: number;
  gasCostUsd: number;
  netPnlUsd: number;
  openTxHash?: string;
  closeTxHash?: string;
}

export interface PnLSummary {
  totalPositions: number;
  totalNetPnlUsd: number;
  totalGasCostUsd: number;
  averageHoldHours: number;
  bestPositionUsd: number;
  worstPositionUsd: number;
}

/**
 * Tracks realized PnL for closed loop positions, persisted to a JSON file
 * so state survives restarts.
 */
export class PnLTracker {
  private records: PnLRecord[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        this.records = Array.isArray(parsed) ? (parsed as PnLRecord[]) : [];
      }
    } catch {
      // Corrupt file should not crash the bot; start fresh.
      this.records = [];
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.records, null, 2));
  }

  record(record: PnLRecord): void {
    this.records.push(record);
    this.save();
  }

  getRecords(): PnLRecord[] {
    return [...this.records];
  }

  getSummary(): PnLSummary {
    if (this.records.length === 0) {
      return {
        totalPositions: 0,
        totalNetPnlUsd: 0,
        totalGasCostUsd: 0,
        averageHoldHours: 0,
        bestPositionUsd: 0,
        worstPositionUsd: 0,
      };
    }

    const pnls = this.records.map((r) => r.netPnlUsd);
    return {
      totalPositions: this.records.length,
      totalNetPnlUsd: pnls.reduce((a, b) => a + b, 0),
      totalGasCostUsd: this.records.reduce((a, r) => a + r.gasCostUsd, 0),
      averageHoldHours:
        this.records.reduce((a, r) => a + r.durationHours, 0) /
        this.records.length,
      bestPositionUsd: Math.max(...pnls),
      worstPositionUsd: Math.min(...pnls),
    };
  }
}
