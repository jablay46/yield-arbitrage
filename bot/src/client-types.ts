import { PublicClient, Transport, WalletClient } from 'viem';
import { base } from 'viem/chains';

/**
 * viem's public/wallet client types are invariant on chain, and Base's
 * OP-stack differences break the generic Chain union — so the clients used
 * across the bot are typed for Base exactly. Transport is kept generic so
 * HTTP and WebSocket (Flashblocks) endpoints are both accepted.
 */
export type BasePublicClient = PublicClient<Transport, typeof base>;
export type BaseWalletClient = WalletClient<Transport, typeof base>;
