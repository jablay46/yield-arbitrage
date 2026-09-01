import fs from 'node:fs';
import path from 'node:path';

import type { OpenPositionInfo } from '../index';

type StoredPosition = Omit<OpenPositionInfo, 'openTxGasUsed'> & {
  openTxGasUsed: string;
};

/**
 * Persists the single active open position to disk so a bot restart recovers
 * the context needed to close it and compute realized PnL (which the in-memory
 * `openPosition` would otherwise lose).
 *
 * BigInts are serialized as strings (JSON has no bigint support) and parsed
 * back on load.
 */
export class PositionStore {
  private filePath: string;
  private position: OpenPositionInfo | undefined;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoredPosition;
      if (!parsed || typeof parsed !== 'object' || !parsed.asset) return;
      this.position = {
        ...parsed,
        openTxGasUsed: BigInt(parsed.openTxGasUsed ?? '0'),
        marginAmount: BigInt(
          (parsed as unknown as { marginAmount: string }).marginAmount ?? '0',
        ),
      } as OpenPositionInfo;
    } catch {
      // Corrupt file should not crash the bot; start with no position.
      this.position = undefined;
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!this.position) {
      try {
        fs.unlinkSync(this.filePath);
      } catch {
        // ignore — file may not exist
      }
      return;
    }
    const serializable: StoredPosition = {
      ...this.position,
      marginAmount: this.position.marginAmount.toString(),
      openTxGasUsed: this.position.openTxGasUsed.toString(),
    } as unknown as StoredPosition;
    fs.writeFileSync(this.filePath, JSON.stringify(serializable, null, 2));
  }

  /** Record the currently open position and persist it. */
  set(position: OpenPositionInfo): void {
    this.position = position;
    this.save();
  }

  /** Clear the persisted position (called after a successful close). */
  clear(): void {
    this.position = undefined;
    this.save();
  }

  /** Get the persisted open position, if any. */
  get(): OpenPositionInfo | undefined {
    return this.position;
  }
}
