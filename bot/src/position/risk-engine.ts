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

  constructor(params: Partial<RiskParams> = {}) {
    this.params = { ...DEFAULT_RISK_PARAMS, ...params };
  }

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

  getOpenPositions(): LoopPosition[] {
    return this.positions.filter((p) => p.status === 'open');
  }

  getAllPositions(): LoopPosition[] {
    return [...this.positions];
  }

  updateParams(params: Partial<RiskParams>): void {
    this.params = { ...this.params, ...params };
  }

  getParams(): RiskParams {
    return { ...this.params };
  }
}
