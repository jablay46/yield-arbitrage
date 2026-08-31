import { Position } from './risk-engine';

/**
 * PnL record for database
 */
export interface PnLRecord {
  id: string;
  timestamp: number;
  
  // Position details
  positionId: string;
  supplyProtocol: string;
  borrowProtocol: string;
  supplyToken: string;
  borrowToken: string;
  
  // Financials
  flashloanAmount: number;  // In USD
  profit: number;          // Gross profit in USD
  gasCost: number;         // Gas cost in USD
  flashloanFee: number;    // Flashloan fee in USD
  netProfit: number;      // Net profit in USD
  
  // Status
  status: 'success' | 'failed' | 'pending';
  txHash?: string;
  error?: string;
  
  // Timing
  executionTimeMs: number;
}

/**
 * PnL summary
 */
export interface PnLSummary {
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  
  totalGrossProfit: number;
  totalGasCost: number;
  totalFlashloanFee: number;
  totalNetProfit: number;
  
  averageProfitPerTrade: number;
  winRate: number;
  
  // Time-based
  profitToday: number;
  profitThisWeek: number;
  profitThisMonth: number;
  
  // Statistics
  bestTrade: number;
  worstTrade: number;
  largestTrade: number;
}

/**
 * PnL Tracker
 * Tracks profit and loss for all arbitrage executions
 */
export class PnLTracker {
  private records: PnLRecord[] = [];
  private byId: Map<string, PnLRecord> = new Map();
  
  /**
   * Record a new trade
   */
  recordTrade(
    position: Position,
    flashloanFeeUsd: number = 0
  ): PnLRecord {
    const record: PnLRecord = {
      id: `pnl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      
      positionId: position.id,
      supplyProtocol: position.opportunity.supplyProtocol,
      borrowProtocol: position.opportunity.borrowProtocol,
      supplyToken: position.opportunity.supplyToken,
      borrowToken: position.opportunity.borrowToken,
      
      flashloanAmount: Number(position.opportunity.flashloanAmount) / 1e6,
      profit: position.profitUsd,
      gasCost: position.gasCostUsd,
      flashloanFee: flashloanFeeUsd,
      netProfit: position.netProfitUsd,
      
      status: position.status === 'completed' ? 'success' : 
             position.status === 'failed' ? 'failed' : 'pending',
      txHash: position.txHash,
      error: position.error,
      
      executionTimeMs: position.closeTime 
        ? position.closeTime - position.openTime 
        : 0,
    };
    
    this.records.push(record);
    this.byId.set(record.id, record);
    
    return record;
  }
  
  /**
   * Update a record
   */
  updateRecord(recordId: string, updates: Partial<PnLRecord>): void {
    const record = this.byId.get(recordId);
    if (record) {
      Object.assign(record, updates);
    }
  }
  
  /**
   * Get all records
   */
  getRecords(): PnLRecord[] {
    return [...this.records];
  }
  
  /**
   * Get record by ID
   */
  getRecord(recordId: string): PnLRecord | undefined {
    return this.byId.get(recordId);
  }
  
  /**
   * Get records for a specific date range
   */
  getRecordsInRange(startTime: number, endTime: number): PnLRecord[] {
    return this.records.filter(
      r => r.timestamp >= startTime && r.timestamp <= endTime
    );
  }
  
  /**
   * Get PnL summary
   */
  getSummary(): PnLSummary {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const weekMs = 7 * dayMs;
    const monthMs = 30 * dayMs;
    
    const successful = this.records.filter(r => r.status === 'success');
    const failed = this.records.filter(r => r.status === 'failed');
    
    const totalGrossProfit = successful.reduce((sum, r) => sum + r.profit, 0);
    const totalGasCost = successful.reduce((sum, r) => sum + r.gasCost, 0);
    const totalFlashloanFee = successful.reduce((sum, r) => sum + r.flashloanFee, 0);
    const totalNetProfit = successful.reduce((sum, r) => sum + r.netProfit, 0);
    
    // Time-based profits
    const profitToday = successful
      .filter(r => r.timestamp > now - dayMs)
      .reduce((sum, r) => sum + r.netProfit, 0);
    
    const profitThisWeek = successful
      .filter(r => r.timestamp > now - weekMs)
      .reduce((sum, r) => sum + r.netProfit, 0);
    
    const profitThisMonth = successful
      .filter(r => r.timestamp > now - monthMs)
      .reduce((sum, r) => sum + r.netProfit, 0);
    
    // Statistics
    const profits = successful.map(r => r.netProfit).filter(p => p > 0);
    const losses = successful.map(r => r.netProfit).filter(p => p < 0);
    
    return {
      totalTrades: this.records.length,
      successfulTrades: successful.length,
      failedTrades: failed.length,
      
      totalGrossProfit,
      totalGasCost,
      totalFlashloanFee,
      totalNetProfit,
      
      averageProfitPerTrade: successful.length > 0 
        ? totalNetProfit / successful.length 
        : 0,
      winRate: successful.length > 0 
        ? (successful.filter(r => r.netProfit > 0).length / successful.length) * 100 
        : 0,
      
      profitToday,
      profitThisWeek,
      profitThisMonth,
      
      bestTrade: profits.length > 0 ? Math.max(...profits) : 0,
      worstTrade: losses.length > 0 ? Math.min(...losses) : 0,
      largestTrade: successful.length > 0 
        ? Math.max(...successful.map(r => r.flashloanAmount)) 
        : 0,
    };
  }
  
  /**
   * Get recent records
   */
  getRecentRecords(limit: number = 10): PnLRecord[] {
    return [...this.records]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }
  
  /**
   * Get records by status
   */
  getRecordsByStatus(status: PnLRecord['status']): PnLRecord[] {
    return this.records.filter(r => r.status === status);
  }
  
  /**
   * Clear old records
   */
  clearOldRecords(olderThanDays: number = 30): number {
    const cutoff = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    const oldRecords = this.records.filter(r => r.timestamp < cutoff);
    
    for (const record of oldRecords) {
      this.byId.delete(record.id);
    }
    
    this.records = this.records.filter(r => r.timestamp >= cutoff);
    
    return oldRecords.length;
  }
  
  /**
   * Export records for analysis
   */
  exportToCSV(): string {
    const headers = [
      'ID',
      'Timestamp',
      'Position ID',
      'Supply Protocol',
      'Borrow Protocol',
      'Supply Token',
      'Borrow Token',
      'Flashloan Amount (USD)',
      'Profit (USD)',
      'Gas Cost (USD)',
      'Flashloan Fee (USD)',
      'Net Profit (USD)',
      'Status',
      'Tx Hash',
      'Execution Time (ms)',
    ];
    
    const rows = this.records.map(r => [
      r.id,
      new Date(r.timestamp).toISOString(),
      r.positionId,
      r.supplyProtocol,
      r.borrowProtocol,
      r.supplyToken,
      r.borrowToken,
      r.flashloanAmount.toFixed(2),
      r.profit.toFixed(2),
      r.gasCost.toFixed(2),
      r.flashloanFee.toFixed(2),
      r.netProfit.toFixed(2),
      r.status,
      r.txHash || '',
      r.executionTimeMs.toString(),
    ]);
    
    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }
}

export default PnLTracker;
