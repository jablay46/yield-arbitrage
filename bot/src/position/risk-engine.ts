/**
 * Risk engine for loop positions.
 * Enforces size limits, cooldowns, and loss limits before any open.
 */

export interface RiskParams {
  maxMarginUsd: number;
  minNetApyBps: number;
  minHealthFactor: number;
  cooldownMs: number;
  maxOpenPositions: number;
}

export const DEFAULT_RISK_PARAMS: RiskParams = {
  maxMarginUsd: 50_000,
  minNetApyBps: 50,
  minHealthFactor: 1.05,
  cooldownMs: 60_000,
  maxOpenPositions: 1, // contract supports one position at a time
};

export interface LoopPosition {
  id: string;
  asset: string;
  leverage: number;
  marginAmount: bigint;
  netApyBpsAtOpen: number;
  healthFactorAtOpen: number;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt?: number;
  openTxHash?: string;
  closeTxHash?: string;
  realizedPnlUsd?: number;
}

export interface CandidateLike {
  symbol: string;
  leverage: number;
  marginUsd: number;
  netApyBps: number;
  projectedHealthFactor: number;
}

export class RiskEngine {
  private params: RiskParams;
  private positions: LoopPosition[] = [];
  private lastActionAt = 0;

  /**
   * Create a new RiskEngine instance.
   * @param params - Partial risk parameters to override defaults
   */
  constructor(params: Partial<RiskParams> = {}) {
    this.params = { ...DEFAULT_RISK_PARAMS, ...params };
  }

  /**
   * Check if a loop candidate is allowed to be opened based on risk limits.
   * @param candidate - The loop candidate to evaluate
   * @returns Object indicating whether the open is allowed and the reason if not
   */
  canOpen(candidate: CandidateLike): { allowed: boolean; reason?: string } {
    const openCount = this.positions.filter((p) => p.status === 'open').length;
    if (openCount >= this.params.maxOpenPositions) {
      return { allowed: false, reason: 'A position is already open' };
    }

    if (candidate.marginUsd > this.params.maxMarginUsd) {
      return {
        allowed: false,
        reason: `Margin $${candidate.marginUsd} exceeds limit $${this.params.maxMarginUsd}`,
      };
    }

    if (candidate.netApyBps < this.params.minNetApyBps) {
      return {
        allowed: false,
        reason: `Net APY ${(candidate.netApyBps / 100).toFixed(2)}% below minimum`,
      };
    }

    if (candidate.projectedHealthFactor < this.params.minHealthFactor) {
      return {
        allowed: false,
        reason: `Projected HF ${candidate.projectedHealthFactor.toFixed(3)} below ${this.params.minHealthFactor}`,
      };
    }

    const sinceLast = Date.now() - this.lastActionAt;
    if (sinceLast < this.params.cooldownMs) {
      return {
        allowed: false,
        reason: `Cooldown: ${Math.ceil((this.params.cooldownMs - sinceLast) / 1000)}s remaining`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a newly opened loop position.
   * @param candidate - The loop candidate that was opened
   * @param marginAmount - The margin amount in smallest token units
   * @param txHash - Optional transaction hash for the open transaction
   * @returns The created position record
   */
  recordOpen(
    candidate: CandidateLike,
    marginAmount: bigint,
    txHash?: string
  ): LoopPosition {
    const position: LoopPosition = {
      id: `loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      asset: candidate.symbol,
      leverage: candidate.leverage,
      marginAmount,
      netApyBpsAtOpen: candidate.netApyBps,
      healthFactorAtOpen: candidate.projectedHealthFactor,
      status: 'open',
      openedAt: Date.now(),
      openTxHash: txHash,
    };
    this.positions.push(position);
    this.lastActionAt = Date.now();
    return position;
  }

  /**
   * Record the closing of a loop position.
   * @param positionId - The ID of the position to close
   * @param txHash - Optional transaction hash for the close transaction
   * @param realizedPnlUsd - Optional realized profit/loss in USD
   */
  recordClose(
    positionId: string,
    txHash?: string,
    realizedPnlUsd?: number
  ): void {
    const position = this.positions.find((p) => p.id === positionId);
    if (!position) return;
    position.status = 'closed';
    position.closedAt = Date.now();
    position.closeTxHash = txHash;
    position.realizedPnlUsd = realizedPnlUsd;
    this.lastActionAt = Date.now();
  }

  /**
   * Record or update the realized PnL for a position.
   * @param positionId - The ID of the position
   * @param realizedPnlUsd - The realized profit/loss in USD
   */
  recordRealizedPnl(positionId: string, realizedPnlUsd: number): void {
    const position = this.positions.find((p) => p.id === positionId);
    if (position) position.realizedPnlUsd = realizedPnlUsd;
  }

  /**
   * Get all currently open positions.
   * @returns Array of open positions
   */
  getOpenPositions(): LoopPosition[] {
    return this.positions.filter((p) => p.status === 'open');
  }

  /**
   * Get all positions (both open and closed).
   * @returns Array of all positions
   */
  getAllPositions(): LoopPosition[] {
    return [...this.positions];
  }

  /**
   * Update risk parameters.
   * @param params - Partial risk parameters to update
   */
  updateParams(params: Partial<RiskParams>): void {
    this.params = { ...this.params, ...params };
  }

  /**
   * Get the current risk parameters.
   * @returns A copy of the current risk parameters
   */
  getParams(): RiskParams {
    return { ...this.params };
  }
}
