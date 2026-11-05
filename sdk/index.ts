/** Ordinary ERC-20 transfers -> ZeroDev Kernel -> RAILGUN. Public recipient data only. */
export { decodeRailgunAddress, prepareRailgunRecipient } from './recipient.ts';
export type { RailgunRecipient } from './recipient.ts';
export { createRailgunAdapter, prepareRailgunReceive } from './receive.ts';
export type { RailgunInput } from './receive.ts';
export { inspectDeposit, relayDeposit, validateDeposit, verifyDeployment, verifyAccount, mined } from './kernel.ts';
export type { Deployment, DepositRecord, DepositExecution, DepositQuote, DepositTerms, DepositConfig, RecoveryArtifacts } from './kernel.ts';
export { createRecoveryFile, parseRecoveryFile, inspectRecovery, recoveryTransaction, recoveryRecord } from './recovery.ts';
export type { RecoveryFile } from './recovery.ts';

export { prepareFlexibleReceive, discoverFunding, readFundingAsset, quoteFunding } from './funding.ts';
export type { FundingAsset } from './funding.ts';
export type { TokenApproval } from './kernel.ts';
