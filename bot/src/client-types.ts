import { HttpTransport, PublicClient, WalletClient } from 'viem';
import { base } from 'viem/chains';

/**
 * viem's PublicClient is invariant on the chain type (OP-stack chains like
 * Base add a `deposit` transaction type), so clients are typed for Base
 * exactly instead of the generic Chain union.
 */
export type BasePublicClient = PublicClient<HttpTransport, typeof base>;
export type BaseWalletClient = WalletClient<HttpTransport, typeof base>;
