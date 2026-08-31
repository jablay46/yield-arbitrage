import { ValidatedOpportunity } from '../monitor/opportunity-filter';

/**
 * Risk parameters configuration
 */
export interface RiskParams {
  // Position limits
  maxPositionSizeUsd: number;
  maxDailyLossUsd: number;
  maxConcurrentPositions: number;
  
  // Exposure limits
  maxExposurePerAsset: Record<string, number>; // Token -> max exposure in USD
  maxExposurePerProtocol: Record<string, number>; // Protocol -> max exposure
  
  // Trading limits
  minTradeSizeUsd: number;
  maxTradeSizeUsd: number;
  
  // Time limits
  maxPositionDuration: number; // milliseconds
  cooldownBetweenTrades: number; // milliseconds
}

/**
 * Position state
 */
export interface Position {
  id: string;
  opportunity: ValidatedOpportunity;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled';
  openTime: number;
  closeTime?: number;
  
  // PnL
  profitUsd: number;
  gasCostUsd: number;
  netProfitUsd: number;
  
  // Execution details
  txHash?: string;
  error?: string;
}

/**
 * Risk engine
 * Enforces risk parameters before execution
 */
export class RiskEngine {
  private params: RiskParams;
  private positions: Map<string, Position> = new Map();
  private dailyLoss: number = 0;
  private lastResetTime: number = Date.now();
  
  constructor(params: Partial<RiskParams>) {
    this.params = {
      maxPositionSizeUsd: params.maxPositionSizeUsd ?? 100000,
      maxDailyLossUsd: params.maxDailyLossUsd ?? 5000,
      maxConcurrentPositions: params.maxConcurrentPositions ?? 3,
      maxExposurePerAsset: params.maxExposurePerAsset ?? {},
      maxExposurePerProtocol: params.maxExposurePerProtocol ?? {},
      minTradeSizeUsd: params.minTradeSizeUsd ?? 100,
      maxTradeSizeUsd: params.maxTradeSizeUsd ?? 50000,
      maxPositionDuration: params.maxPositionDuration ?? 300000, // 5 minutes
      cooldownBetweenTrades: params.cooldownBetweenTrades ?? 10000, // 10 seconds
    };
  }
  
  /**
   * Check if opportunity passes risk checks
   */
  canExecute(opportunity: ValidatedOpportunity): {
    allowed: boolean;
    reason?: string;
  } {
    // Check if already at max concurrent positions
    const activePositions = this.getActivePositions().length;
    if (activePositions >= this.params.maxConcurrentPositions) {
      return { allowed: false, reason: 'Max concurrent positions reached' };
    }
    
    // Check position size
    const tradeSizeUsd = Number(opportunity.flashloanAmount) / 1e6;
    if (tradeSizeUsd < this.params.minTradeSizeUsd) {
      return { allowed: false, reason: 'Trade size below minimum' };
    }
    if (tradeSizeUsd > this.params.maxTradeSizeUsd) {
      return { allowed: false, reason: 'Trade size above maximum' };
    }
    
    // Check daily loss limit
    this.checkDailyLossReset();
    if (this.dailyLoss >= this.params.maxDailyLossUsd) {
      return { allowed: false, reason: 'Daily loss limit reached' };
    }
    
    // Check exposure per asset
    const assetExposure = this.getAssetExposure(opportunity.supplyToken);
    const assetLimit = this.params.maxExposurePerAsset[opportunity.supplyToken] 
      ?? this.params.maxPositionSizeUsd;
    if (assetExposure + tradeSizeUsd > assetLimit) {
      return { allowed: false, reason: 'Asset exposure limit reached' };
    }
    
    // Check exposure per protocol
    const protocolExposure = this.getProtocolExposure(opportunity.supplyProtocol);
    const protocolLimit = this.params.maxExposurePerProtocol[opportunity.supplyProtocol]
      ?? this.params.maxPositionSizeUsd;
    if (protocolExposure + tradeSizeUsd > protocolLimit) {
      return { allowed: false, reason: 'Protocol exposure limit reached' };
    }
    
    // Check profitability
    if (!opportunity.isProfitable || opportunity.netProfitUsd < 0) {
      return { allowed: false, reason: 'Opportunity not profitable' };
    }
    
    // Check confidence
    if (opportunity.confidence < 50) {
      return { allowed: false, reason: 'Low confidence score' };
    }
    
    return { allowed: true };
  }
  
  /**
   * Open a new position
   */
  openPosition(opportunity: ValidatedOpportunity): Position {
    const position: Position = {
      id: `pos-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      opportunity,
      status: 'pending',
      openTime: Date.now(),
      profitUsd: 0,
      gasCostUsd: opportunity.estimatedGasCostUsd,
      netProfitUsd: 0,
    };
    
    this.positions.set(position.id, position);
    return position;
  }
  
  /**
   * Update position status
   */
  updatePosition(
    positionId: string,
    status: Position['status'],
    data?: Partial<Position>
  ): void {
    const position = this.positions.get(positionId);
    if (!position) return;
    
    position.status = status;
    if (data) {
      Object.assign(position, data);
    }
    
    if (status === 'completed' || status === 'failed') {
      position.closeTime = Date.now();
      
      // Update daily loss if negative
      if (position.netProfitUsd < 0) {
        this.dailyLoss += Math.abs(position.netProfitUsd);
      }
    }
  }
  
  /**
   * Get active positions
   */
  getActivePositions(): Position[] {
    return Array.from(this.positions.values()).filter(
      p => p.status === 'pending' || p.status === 'executing'
    );
  }
  
  /**
   * Get all positions
   */
  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }
  
  /**
   * Get position by ID
   */
  getPosition(positionId: string): Position | undefined {
    return this.positions.get(positionId);
  }
  
  /**
   * Get asset exposure
   */
  private getAssetExposure(token: string): number {
    return this.getActivePositions()
      .filter(p => p.opportunity.supplyToken === token)
      .reduce((sum, p) => sum + Number(p.opportunity.flashloanAmount) / 1e6, 0);
  }
  
  /**
   * Get protocol exposure
   */
  private getProtocolExposure(protocol: string): number {
    return this.getActivePositions()
      .filter(p => p.opportunity.supplyProtocol === protocol)
      .reduce((sum, p) => sum + Number(p.opportunity.flashloanAmount) / 1e6, 0);
  }
  
  /**
   * Reset daily loss if needed
   */
  private checkDailyLossReset(): void {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    
    if (now - this.lastResetTime > dayMs) {
      this.dailyLoss = 0;
      this.lastResetTime = now;
    }
  }
  
  /**
   * Update risk parameters
   */
  updateParams(params: Partial<RiskParams>): void {
    this.params = {
      ...this.params,
      ...params,
    };
  }
  
  /**
   * Get current risk parameters
   */
  getParams(): RiskParams {
    return { ...this.params };
  }
  
  /**
   * Get statistics
   */
  getStats(): {
    activePositions: number;
    totalPositions: number;
    dailyLossUsd: number;
    dailyLossLimitUsd: number;
  } {
    this.checkDailyLossReset();
    
    return {
      activePositions: this.getActivePositions().length,
      totalPositions: this.positions.size,
      dailyLossUsd: this.dailyLoss,
      dailyLossLimitUsd: this.params.maxDailyLossUsd,
    };
  }
}

export default RiskEngine;
